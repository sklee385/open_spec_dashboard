import { BadRequestException, ConflictException, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { LegacyService } from '../legacy/legacy.service';
import { Work, WorkStore } from './store';
import { localRuntimeDirectory, runtimeCommand, runtimeEnvironment } from '../runtime';
import { collectFiles, FileResults, Snapshot, snapshotRevision } from './file-results';
import { projectCoordinator } from '../projects/coordinator';
import { relatedTestCommands, type TestScope } from './test-commands';
import { desktopHealth } from '../desktop/health';
import { WorkspaceService } from './workspace.service';
import { guardBrowserProcess } from '../browser/browser-job';
import { stopOwnedProcess } from '../browser/browser-process';

export interface VerificationCommand { id: string; command: string; args: string[]; }
interface VerificationReadCommands { full: VerificationCommand[]; work: VerificationCommand[]; }
@Injectable()
export class ExecutionService implements OnModuleDestroy {
  private get files() { return new FileResults(this.store); }
  prepare(work: Work, transition = false) { return this.files.prepare(work, transition); }
  executionPath(work: Work) { return this.files.path(work); }
  queryPath(work: Work) { return new WorkspaceService(this.store).queryPath(work); }
  changeReport(work: Work) { return this.files.report(work); }
  apply(work: Work) {
    const release = projectCoordinator(this.store).acquireOperation({ kind: 'integration', root: work.projectPath, spaces: [this.executionPath(work)] });
    try { return this.files.apply(work); } finally { release(); }
  }
  freeze(work: Work, files?: Snapshot) { work.completedCommands = this.commands(work); return this.files.freeze(work, files); }
  private children = new Map<string, ChildProcess>();
  private batches = new Map<string, { scope: TestScope; remaining: string[] }>();
  private closing = false;
  private interrupted = new Set<string>();
  private candidateChildren = new Map<string, ChildProcess>();
  constructor(@Inject(WorkStore) readonly store: WorkStore, @Inject(LegacyService) readonly legacy: LegacyService) {
    desktopHealth(store).register('verification', work => this.children.has(work.id) || this.batches.has(work.id) ? 'active' : undefined);
    for (const work of store.list().filter(work => !['completed', 'archived'].includes(work.phase))) for (const record of store.records(work.id, 'verification').filter(x => x.status === 'running')) store.record(record.id, work.id, 'verification', { ...record, status: 'interrupted', error: '서버 재시작으로 검증 결과를 확인할 수 없습니다' });
  }
  snapshot(work: Work, validatedRoot?: string): Snapshot { return this.files.snapshot(work, validatedRoot); }
  revision(work: Work) { return snapshotRevision(this.snapshot(work)); }
  baseline(work: Work) { this.prepare(work); }
  changes(work: Work) { return this.changeReport(work).files; }
  commands(work: Work, scope: TestScope = 'full', changedFiles?: { path: string }[], validatedRoot?: string): VerificationCommand[] {
    if (scope === 'work') return Array.isArray(work.workVerificationCommands) ? work.workVerificationCommands as VerificationCommand[] : ['completed', 'archived'].includes(work.phase) ? [] : relatedTestCommands(this.queryPath(work), (changedFiles ?? this.changes(work)).map((file: { path: string }) => file.path));
    if (['completed', 'archived'].includes(work.phase) && Array.isArray(work.completedCommands)) return work.completedCommands as VerificationCommand[];
    if (Array.isArray(work.verificationCommands)) return work.verificationCommands as VerificationCommand[];
    const pkg = join(validatedRoot ?? this.queryPath(work), 'package.json');
    if (!existsSync(pkg)) return [];
    const scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts || {};
    return [scripts['test:run'] ? 'test:run' : 'test', 'typecheck', 'build', 'lint'].filter(id => scripts[id]).map(id => ({ id, command: process.env.NPM_BIN || 'npm', args: ['run', id] }));
  }
  setCommands(work: Work, body: any) {
    if (this.children.has(work.id) || !['idle', 'interrupted', 'failed'].includes(work.state) || ['completed', 'archived'].includes(work.phase)) throw new ConflictException('현재 상태에서는 검증 계획을 바꿀 수 없습니다');
    if (!Array.isArray(body?.commands) || !body.commands.length || body.commands.some((c: any) => !c || typeof c.id !== 'string' || !/^[a-zA-Z0-9:_-]+$/.test(c.id) || typeof c.command !== 'string' || !c.command.trim() || !Array.isArray(c.args) || c.args.some((arg: any) => typeof arg !== 'string'))) throw new BadRequestException('검증은 ID, 실행 파일, 인자 배열이 필요합니다');
    if (new Set(body.commands.map((c: any) => c.id)).size !== body.commands.length) throw new BadRequestException('중복된 검증 ID입니다');
    if (body.scope !== undefined && !['work', 'full'].includes(body.scope)) throw new BadRequestException('잘못된 테스트 범위입니다');
    work[body.scope === 'work' ? 'workVerificationCommands' : 'verificationCommands'] = body.commands; this.store.save(work); return this.commands(work, body.scope || 'full');
  }
  results(work: Work, capturedRevision?: string, readCommands?: VerificationReadCommands) {
    // Internal callers may reuse their own source read, never a revision cached across requests.
    let revision: string | null = capturedRevision || null;
    if (!capturedRevision) {
      try { revision = ['completed', 'archived'].includes(work.phase) ? this.store.records(work.id, 'completed-changes')[0]?.report?.revision ?? null : this.revision(work); } catch { /* Missing historical isolation is not a current result. */ }
    }
    const commands = readCommands ?? { full: this.commands(work), work: this.commands(work, 'work') };
    return this.store.records(work.id, 'verification').map(record => ({ ...record, scope: record.scope || 'full', fresh: record.sourceMutationVersion === work.sourceMutationVersion && record.revision === revision && record.commandVersion === JSON.stringify(commands[record.scope === 'work' ? 'work' : 'full'].find(x => x.id === record.commandId)) }));
  }
  runAll(work: Work, scope: TestScope) {
    if (!['work', 'full'].includes(scope)) throw new BadRequestException('잘못된 테스트 범위입니다');
    if (this.batches.has(work.id)) throw new ConflictException('이미 테스트가 실행 중입니다');
    const commands = this.commands(work, scope);
    if (!commands.length) throw new BadRequestException(scope === 'work' ? '변경 관련 테스트를 찾지 못했습니다. 작업 테스트 명령을 등록해 주세요.' : '전체 테스트 명령을 등록해 주세요.');
    const result = this.run(work, commands[0].id, scope);
    this.batches.set(work.id, { scope, remaining: commands.slice(1).map(command => command.id) });
    return result;
  }
  run(work: Work, commandId: string, scope: TestScope = 'full') {
    desktopHealth(this.store).assertExecutionAllowed();
    if (!['work', 'full'].includes(scope)) throw new BadRequestException('잘못된 테스트 범위입니다');
    projectCoordinator(this.store).assertActivityCanStart(work, 'verification');
    if (this.children.has(work.id) || !['idle', 'interrupted', 'failed'].includes(work.state) || ['completed', 'archived'].includes(work.phase)) throw new ConflictException('업무의 다른 실행이 진행 중이거나 완료되었습니다');
    const cwd = this.executionPath(work);
    this.files.assertSourcePlan(work);
    const command = this.commands(work, scope).find(c => c.id === commandId); if (!command) throw new BadRequestException('등록된 검증 명령이 아닙니다');
    const started = Date.now();
    const record = { id: randomUUID(), commandId, scope, commandVersion: JSON.stringify(command), revision: this.revision(work), sourceMutationVersion: work.sourceMutationVersion, status: 'running', stdout: '', stderr: '', code: null as number | null, createdAt: new Date().toISOString(), durationMs: null as number | null };
    this.store.record(record.id, work.id, 'verification', record); work.phase = 'verification'; work.state = 'running'; this.store.save(work);
    const runtime = join(cwd, '.tools', 'node-runtime');
    const local = existsSync(join(runtime, process.platform === 'win32' ? 'node.exe' : 'node')) ? runtime : undefined;
    const executable = runtimeCommand(command.command, command.args, local);
    const env = runtimeEnvironment(process.env, local);
    for (const key of ['DATA_DIR', 'CONFIG_PATH', 'WORKSPACE_ROOT', 'DESKTOP_TOKEN', 'OPENSPEC_NODE_DIRECTORY']) delete env[key];
    if (local) env.OPENSPEC_NODE_DIRECTORY = local;
    const child = spawn(executable.command, executable.args, { cwd, shell: false, windowsHide: true, env }); this.children.set(work.id, child);
    const timer = setTimeout(() => child.kill(), 600000);
    let finished = false;
    const finish = (code: number | null, error?: string) => {
      if (finished) return; finished = true; clearTimeout(timer); this.children.delete(work.id);
      if (this.closing) return;
      record.durationMs = Date.now() - started;
      record.code = code; record.status = this.interrupted.delete(work.id) ? 'interrupted' : code === 0 && !error ? 'passed' : 'failed'; if (error) record.stderr += error;
      if (record.status === 'failed') desktopHealth(this.store).event('execution-failed', work.id, 'failed', 'verification-failed');
      this.store.record(record.id, work.id, 'verification', record); const latest = this.store.get(work.id)!; latest.state = 'idle'; this.store.save(latest);
      const batch = this.batches.get(work.id), next = batch?.remaining.shift();
      if (record.status === 'passed' && next && batch) {
        try { this.run(latest, next, batch.scope); }
        catch (failure: any) { this.batches.delete(work.id); latest.error = failure.message; this.store.save(latest); }
      } else this.batches.delete(work.id);
      this.store.event(work.id, 'verification', record); this.legacy.updates.next();
    };
    child.stdout?.on('data', chunk => { record.stdout += chunk; if (record.stdout.length > 2000000) child.kill(); });
    child.stderr?.on('data', chunk => { record.stderr += chunk; if (record.stderr.length > 2000000) child.kill(); });
    child.once('error', error => finish(null, error.message)); child.once('close', code => finish(code)); return record;
  }
  interrupt(id: string) {
    const child = this.children.get(id); if (!child) return false;
    this.batches.delete(id); this.interrupted.add(id); child.kill(); return true;
  }
  /** Candidate context is explicit: never changes Work phase, commands or verification history. */
  candidateCommandContext(commands: VerificationCommand[]) {
    const configured = localRuntimeDirectory(), directory = configured ? realpathSync(configured) : undefined;
    return { hostExecutable: realpathSync(process.execPath), hostNodeVersion: process.version, runtimeDirectory: directory ?? null, commands: commands.map(command => ({ id: command.id, ...runtimeCommand(command.command, command.args, directory) })) };
  }
  async runCandidateCommand(runId: string, cwd: string, command: VerificationCommand, signal: AbortSignal, onSpawn: (pid: number) => void) {
    const result = { commandId: command.id, commandVersion: JSON.stringify(command), stdout: '', stderr: '', code: null as number | null, status: 'blocked', processTerminated: true, terminationEvidence: 'not-started' };
    if (signal.aborted || this.closing) return { ...result, status: 'interrupted' };
    const context = this.candidateCommandContext([command]), executable = context.commands[0], env = runtimeEnvironment(process.env, context.runtimeDirectory ?? undefined);
    const privateEnvironment = new Set(['DATA_DIR', 'CONFIG_PATH', 'WORKSPACE_ROOT', 'DESKTOP_TOKEN', 'OPENSPEC_NODE_DIRECTORY', 'NODE_OPTIONS', 'NODE_PATH']);
    for (const key of Object.keys(env)) if (privateEnvironment.has(key.toUpperCase()) || key.toUpperCase().startsWith('GIT_')) delete env[key];
    // Same waiting-worker / kill-on-close Job contract as local preparation.
    const worker = "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{try{const c=JSON.parse(s);const p=require('child_process').spawn(c.command,c.args,{cwd:process.cwd(),env:process.env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.pipe(process.stdout);p.stderr.pipe(process.stderr);p.once('error',e=>{console.error(e.message);process.exit(1)});p.once('close',c=>process.exit(c===0?0:1));}catch{process.exit(1)}});";
    const child = spawn(process.execPath, ['-e', worker], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    result.terminationEvidence = 'unconfirmed';
    this.candidateChildren.set(runId, child);
    const closed = new Promise<void>(resolve => { child.once('error', error => { result.stderr += error.message; resolve(); }); child.once('close', code => { result.code = code; resolve(); }); });
    const guard = guardBrowserProcess(child); void guard.catch(() => {});
    let interrupted = false, exceeded = false, dispatched = false;
    // Stop only this live owned ChildProcess. Never discover/kill a persisted PID.
    const stop = () => { interrupted = true; void stopOwnedProcess(child).catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 600000);
    const output = (key: 'stdout' | 'stderr', chunk: Buffer) => { const value = chunk.toString(); result[key] = (result[key] + value).slice(0, 2000000); if (value.length + result[key].length >= 2000000) { exceeded = true; stop(); } };
    child.stdout!.on('data', chunk => output('stdout', chunk)); child.stderr!.on('data', chunk => output('stderr', chunk));
    child.stdin!.on('error', stop);
    try {
      if (child.pid) onSpawn(child.pid);
      const owned = await guard;
      if (signal.aborted || this.closing) stop(); else { dispatched = true; child.stdin!.end(JSON.stringify(executable)); }
      await closed; await owned.done;
      result.terminationEvidence = 'job-and-worker-closed';
      result.status = interrupted ? 'interrupted' : result.code === 0 && !exceeded ? 'passed' : 'failed';
    } catch (error: any) {
      result.stderr += error.message;
      // A guard failure never permits project code; uncertain cleanup retains the scope.
      try { await stopOwnedProcess(child); await closed; await (await guard).done; }
      catch { result.processTerminated = !child.pid || !dispatched && (child.exitCode !== null || child.signalCode !== null); }
      result.terminationEvidence = result.processTerminated ? dispatched ? 'job-and-worker-closed' : 'waiting-worker-closed' : 'unconfirmed';
      result.status = signal.aborted ? 'interrupted' : 'blocked';
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', stop);
      if (result.processTerminated) this.candidateChildren.delete(runId);
    }
    return result;
  }
  onModuleDestroy() { this.closing = true; for (const child of this.children.values()) child.kill(); this.children.clear(); for (const child of this.candidateChildren.values()) void stopOwnedProcess(child).catch(() => {}); }
}
