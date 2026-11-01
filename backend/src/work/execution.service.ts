import { BadRequestException, ConflictException, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { LegacyService } from '../legacy/legacy.service';
import { Work, WorkStore } from './store';
import { localRuntimeDirectory, runtimeCommand, runtimeEnvironment } from '../runtime';
import { collectFiles, FileResults, Snapshot, snapshotRevision, type GitCompletionCapture } from './file-results';
import { projectCoordinator } from '../projects/coordinator';
import { relatedTestCommands, uniqueTestCommands, type TestScope } from './test-commands';
import { desktopHealth } from '../desktop/health';
import { WorkspaceService } from './workspace.service';
import { guardBrowserProcess, guardWorkerPath } from '../browser/browser-job';
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
  freeze(work: Work, files?: Snapshot, git?: GitCompletionCapture) { work.completedCommands = this.requiredPlan(work).commands; return this.files.freeze(work, files, git); }
  private children = new Map<string, { abort: AbortController; done: Promise<void>; terminated: boolean }>();
  private batches = new Map<string, { scope: TestScope; remaining: string[] }>();
  private closing = false;
  private interrupted = new Set<string>();
  private candidateChildren = new Map<string, ChildProcess>();
  constructor(@Inject(WorkStore) readonly store: WorkStore, @Inject(LegacyService) readonly legacy: LegacyService) {
    desktopHealth(store).register('verification', work => this.children.has(work.id) ? this.children.get(work.id)!.terminated ? 'active' : 'unknown' : this.terminationPending(work.id) ? 'unknown' : this.batches.has(work.id) ? 'active' : undefined);
    for (const work of store.list().filter(work => !['completed', 'archived'].includes(work.phase))) for (const record of store.records(work.id, 'verification').filter(x => x.status === 'running')) store.record(record.id, work.id, 'verification', { ...record, status: 'interrupted', error: '서버 재시작으로 검증 결과를 확인할 수 없습니다' });
  }
  private terminationPending(workId: string) {
    return !!this.store.db.prepare("SELECT 1 FROM records WHERE work_id=? AND kind='verification' AND json_extract(data,'$.evidenceVersion')=1 AND COALESCE(json_extract(data,'$.processTerminated'),0)<>1 LIMIT 1").get(workId);
  }
  snapshot(work: Work, validatedRoot?: string): Snapshot { return this.files.snapshot(work, validatedRoot); }
  revision(work: Work) { return snapshotRevision(this.snapshot(work)); }
  baseline(work: Work) { this.prepare(work); }
  changes(work: Work) { return this.changeReport(work).files; }
  commands(work: Work, scope: TestScope = 'full', changedFiles?: { path: string }[], validatedRoot?: string): VerificationCommand[] {
    if (scope === 'work') return uniqueTestCommands(Array.isArray(work.workVerificationCommands) ? work.workVerificationCommands as VerificationCommand[] : ['completed', 'archived'].includes(work.phase) ? [] : relatedTestCommands(validatedRoot ?? this.queryPath(work), (changedFiles ?? this.changes(work))));
    if (['completed', 'archived'].includes(work.phase) && Array.isArray(work.completedCommands)) return work.completedCommands as VerificationCommand[];
    if (Array.isArray(work.verificationCommands)) return uniqueTestCommands(work.verificationCommands as VerificationCommand[]);
    const pkg = join(validatedRoot ?? this.queryPath(work), 'package.json');
    if (!existsSync(pkg)) return [];
    const scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts || {};
    return [scripts['test:run'] ? 'test:run' : 'test', 'typecheck', 'build', 'lint'].filter(id => scripts[id]).map(id => ({ id, command: process.env.NPM_BIN || 'npm', args: ['run', id] }));
  }
  requiredPlan(work: Work, changedFiles?: { path: string }[], root?: string, selected?: TestScope, capturedCommands?: VerificationReadCommands) {
    const scope: TestScope = selected ?? (work.verificationScope === 'work' || work.verificationScope === 'full' ? work.verificationScope : Array.isArray(work.verificationCommands) ? 'full' : 'work');
    const commands = capturedCommands?.[scope] ?? this.commands(work, scope, changedFiles, root);
    const reason = scope === 'full' ? '사용자가 선택하거나 등록한 전체 검증 계획입니다.' : commands.length ? '변경 영향에 해당하는 작업 검증 계획입니다.' : '변경 관련 명령을 찾지 못했습니다. 작업 명령을 등록하거나 전체 검증을 명시적으로 선택해 주세요.';
    return { scope, commands, reason };
  }
  /** Hash only; never publish environment values or private file contents. */
  verificationContext(work: Work, command: VerificationCommand) {
    const root = realpathSync(this.executionPath(work)), inputVersion = createHash('sha256').update(JSON.stringify(collectFiles(root, () => false, true))).digest('hex');
    return createHash('sha256').update(JSON.stringify([1, work.id, work.workspace?.workspaceId ?? null, root, inputVersion, this.candidateCommandContext([command]), command])).digest('hex');
  }
  setCommands(work: Work, body: any) {
    if (this.children.has(work.id) || !['idle', 'interrupted', 'failed'].includes(work.state) || ['completed', 'archived'].includes(work.phase)) throw new ConflictException('현재 상태에서는 검증 계획을 바꿀 수 없습니다');
    if (!Array.isArray(body?.commands) || !body.commands.length || body.commands.some((c: any) => !c || typeof c.id !== 'string' || !/^[a-zA-Z0-9:_-]+$/.test(c.id) || typeof c.command !== 'string' || !c.command.trim() || !Array.isArray(c.args) || c.args.some((arg: any) => typeof arg !== 'string'))) throw new BadRequestException('검증은 ID, 실행 파일, 인자 배열이 필요합니다');
    if (new Set(body.commands.map((c: any) => c.id)).size !== body.commands.length) throw new BadRequestException('중복된 검증 ID입니다');
    if (body.scope !== undefined && !['work', 'full'].includes(body.scope)) throw new BadRequestException('잘못된 테스트 범위입니다');
    work.verificationScope = body.scope || 'full'; work[body.scope === 'work' ? 'workVerificationCommands' : 'verificationCommands'] = uniqueTestCommands(body.commands); this.store.save(work); return this.commands(work, body.scope || 'full');
  }
  results(work: Work, capturedRevision?: string, readCommands?: VerificationReadCommands) {
    // Internal callers may reuse their own source read, never a revision cached across requests.
    let revision: string | null = capturedRevision || null;
    if (!capturedRevision) {
      try { revision = ['completed', 'archived'].includes(work.phase) ? this.store.records(work.id, 'completed-changes')[0]?.report?.revision ?? null : this.revision(work); } catch { /* Missing historical isolation is not a current result. */ }
    }
    const commands = readCommands ?? { full: this.commands(work), work: this.commands(work, 'work') };
    const contexts = new Map<string, string>();
    return this.store.records(work.id, 'verification').map(record => {
      const command = commands[record.scope === 'work' ? 'work' : 'full'].find(x => x.id === record.commandId);
      let context: string | undefined; try { if (command) { const key = JSON.stringify(command); context = contexts.get(key) ?? this.verificationContext(work, command); contexts.set(key, context); } } catch { /* Unknown runtime cannot validate historical evidence. */ }
      return { ...record, scope: record.scope || 'full', fresh: !!command && record.evidenceVersion === 1 && record.processTerminated === true && record.terminationEvidence === 'job-and-worker-closed' && record.contextVersion === context && record.sourceMutationVersion === work.sourceMutationVersion && record.revision === revision && record.commandVersion === JSON.stringify(command) };
    });
  }
  runAll(work: Work, scope: TestScope) {
    desktopHealth(this.store).assertExecutionAllowed();
    projectCoordinator(this.store).assertActivityCanStart(work, 'verification');
    this.files.assertSourcePlan(work);
    if (!['work', 'full'].includes(scope)) throw new BadRequestException('잘못된 테스트 범위입니다');
    if (this.children.has(work.id) || this.batches.has(work.id) || this.terminationPending(work.id)) throw new ConflictException('이미 테스트가 실행 중입니다');
    if (!['idle', 'interrupted', 'failed'].includes(work.state) || ['completed', 'archived'].includes(work.phase)) throw new ConflictException('현재 상태에서는 검증을 실행할 수 없습니다');
    const commands = this.commands(work, scope);
    if (!commands.length) throw new BadRequestException(scope === 'work' ? '변경 관련 테스트를 찾지 못했습니다. 작업 테스트 명령을 등록해 주세요.' : '전체 테스트 명령을 등록해 주세요.');
    work.verificationScope = scope; this.store.save(work);
    const results = this.results(work), pending = commands.filter(command => { const latest = results.filter(row => row.commandId === command.id && row.scope === scope).at(-1); return latest?.status !== 'passed' || latest.fresh !== true || latest.cacheable !== true; });
    if (!pending.length) { work.phase = 'verification'; this.store.save(work); return { status: 'passed', reused: true, verificationRefs: commands.map(command => results.filter(row => row.commandId === command.id && row.scope === scope).at(-1)!.id) }; }
    this.batches.set(work.id, { scope, remaining: pending.slice(1).map(command => command.id) });
    try { return this.run(work, pending[0].id, scope); } catch (error) { this.batches.delete(work.id); throw error; }
  }
  run(work: Work, commandId: string, scope: TestScope = 'full') {
    desktopHealth(this.store).assertExecutionAllowed();
    if (!['work', 'full'].includes(scope)) throw new BadRequestException('잘못된 테스트 범위입니다');
    projectCoordinator(this.store).assertActivityCanStart(work, 'verification');
    if (this.children.has(work.id) || this.terminationPending(work.id) || !['idle', 'interrupted', 'failed'].includes(work.state) || ['completed', 'archived'].includes(work.phase)) throw new ConflictException('업무의 다른 실행이 진행 중이거나 완료되었습니다');
    const cwd = this.executionPath(work); this.files.assertSourcePlan(work);
    const command = this.commands(work, scope).find(c => c.id === commandId); if (!command) throw new BadRequestException('등록된 검증 명령이 아닙니다');
    const latest = this.results(work).filter(row => row.commandId === commandId && row.scope === scope).at(-1);
    if (latest?.status === 'passed' && latest.fresh === true && latest.cacheable === true) return { ...latest, reused: true };
    const started = Date.now(), abort = new AbortController();
    const record: any = { id: randomUUID(), commandId, scope, commandVersion: JSON.stringify(command), revision: this.revision(work), sourceMutationVersion: work.sourceMutationVersion, contextVersion: this.verificationContext(work, command), evidenceVersion: 1, processTerminated: false, terminationEvidence: 'unconfirmed', status: 'running', stdout: '', stderr: '', code: null, createdAt: new Date().toISOString(), durationMs: null };
    this.store.record(record.id, work.id, 'verification', record); work.verificationScope = scope; work.phase = 'verification'; work.state = 'running'; this.store.save(work);
    const active = { abort, done: Promise.resolve(), terminated: true }; this.children.set(work.id, active);
    active.done = (async () => {
      try { Object.assign(record, await this.runCandidateCommand(record.id, cwd, command, abort.signal, () => {})); }
      catch (error: any) { record.status = 'blocked'; record.stderr += error.message; record.processTerminated = false; }
      active.terminated = record.processTerminated === true;
      if (active.terminated) this.children.delete(work.id);
      if (this.closing) {
        // Nest keeps the store open until module destruction settles. Preserve
        // observed termination; a restart must not turn this owned receipt unknown.
        if (active.terminated) {
          record.status = 'interrupted'; record.durationMs = Date.now() - started;
          this.store.transaction(() => {
            this.store.record(record.id, work.id, 'verification', record);
            const current = this.store.get(work.id);
            if (current?.state === 'running') { current.state = 'idle'; this.store.save(current); }
          });
        }
        return;
      }
      record.durationMs = Date.now() - started;
      if (this.interrupted.delete(work.id)) record.status = 'interrupted';
      const current = this.store.get(work.id)!;
      this.store.transaction(() => {
        this.store.record(record.id, work.id, 'verification', record);
        current.state = active.terminated ? 'idle' : 'interrupted'; this.store.save(current);
      });
      if (record.status === 'failed') desktopHealth(this.store).event('execution-failed', work.id, 'failed', 'verification-failed');
      const batch = this.batches.get(work.id), next = batch?.remaining.shift();
      if (record.status === 'passed' && active.terminated && next && batch) {
        try { this.run(current, next, batch.scope); } catch (error: any) { this.batches.delete(work.id); current.error = error.message; this.store.save(current); }
      } else this.batches.delete(work.id);
      this.store.event(work.id, 'verification', record); this.legacy.updates.next();
    })();
    return record;
  }
  interrupt(id: string) {
    const active = this.children.get(id); if (!active) return false;
    this.batches.delete(id); this.interrupted.add(id); active.abort.abort(); return true;
  }
  /** Candidate context is explicit: never changes Work phase, commands or verification history. */
  candidateCommandContext(commands: VerificationCommand[]) {
    const configured = localRuntimeDirectory(), directory = configured ? realpathSync(configured) : undefined;
    const env = this.commandEnvironment(directory);
    const fingerprints = new Map<string, string>();
    const fingerprint = (path: string) => {
      if (!isAbsolute(path) || !existsSync(path)) return null;
      const real = realpathSync(path); if (!fingerprints.has(real)) fingerprints.set(real, createHash('sha256').update(readFileSync(real)).digest('hex'));
      return fingerprints.get(real)!;
    };
    const runtimeVersion = [fingerprint(process.execPath), directory ? fingerprint(join(directory, process.platform === 'win32' ? 'node.exe' : 'node')) : null, directory ? fingerprint(join(directory, 'node_modules/npm/bin/npm-cli.js')) : null];
    const environmentVersion = createHash('sha256').update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
    return { environmentVersion, runtimeVersion, hostExecutable: realpathSync(process.execPath), hostNodeVersion: process.version, runtimeDirectory: directory ?? null, commands: commands.map(command => { const executable = runtimeCommand(command.command, command.args, directory); return { id: command.id, ...executable, executableVersion: fingerprint(executable.command) }; }) };
  }

  private commandEnvironment(directory?: string) {
    const env = runtimeEnvironment(process.env, directory);
    const privateEnvironment = new Set(['DATA_DIR', 'CONFIG_PATH', 'WORKSPACE_ROOT', 'DESKTOP_TOKEN', 'OPENSPEC_NODE_DIRECTORY', 'NODE_OPTIONS', 'NODE_PATH']);
    for (const key of Object.keys(env)) if (privateEnvironment.has(key.toUpperCase()) || key.toUpperCase().startsWith('GIT_')) delete env[key];
    return env;
  }
  async runCandidateCommand(runId: string, cwd: string, command: VerificationCommand, signal: AbortSignal, onSpawn: (pid: number) => void) {
    const result = { commandId: command.id, commandVersion: JSON.stringify(command), stdout: '', stderr: '', code: null as number | null, status: 'blocked', cacheable: false, processTerminated: true, terminationEvidence: 'not-started' };
    if (signal.aborted || this.closing) return { ...result, status: 'interrupted' };
    const context = this.candidateCommandContext([command]), executable = context.commands[0], env = this.commandEnvironment(context.runtimeDirectory ?? undefined);
    result.cacheable = context.commands.every(item => item.executableVersion !== null);
    // Same waiting-worker / kill-on-close Job contract as local preparation.
    const worker = "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{try{const c=JSON.parse(s);const p=require('child_process').spawn(c.command,c.args,{cwd:process.cwd(),env:process.env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.pipe(process.stdout);p.stderr.pipe(process.stderr);p.once('error',e=>{console.error(e.message);process.exit(1)});p.once('close',c=>process.exit(c===0?0:1));}catch{process.exit(1)}});";
    const child = spawn(process.execPath, ['--require', guardWorkerPath(), '-e', worker], { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
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
  async onModuleDestroy() { this.closing = true; this.batches.clear(); for (const active of this.children.values()) active.abort.abort(); for (const child of this.candidateChildren.values()) void stopOwnedProcess(child).catch(() => {}); await Promise.allSettled([...this.children.values()].map(active => active.done)); }
}
