import { BadRequestException, ConflictException, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LegacyService } from '../legacy/legacy.service';
import { Work, WorkStore } from './store';
import { runtimeCommand, runtimeEnvironment } from '../runtime';
import { collectFiles, FileResults, Snapshot, snapshotRevision } from './file-results';
import { projectCoordinator } from '../projects/coordinator';
import { relatedTestCommands, type TestScope } from './test-commands';

export interface VerificationCommand { id: string; command: string; args: string[]; }
@Injectable()
export class ExecutionService implements OnModuleDestroy {
  private get files() { return new FileResults(this.store); }
  prepare(work: Work, transition = false) { return this.files.prepare(work, transition); }
  executionPath(work: Work) { return this.files.path(work); }
  changeReport(work: Work) { return this.files.report(work); }
  apply(work: Work) {
    const release = projectCoordinator(this.store).acquire(work.projectPath);
    try { return this.files.apply(work); } finally { release(); }
  }
  freeze(work: Work, files?: Snapshot) { work.completedCommands = this.commands(work); return this.files.freeze(work, files); }
  private children = new Map<string, ChildProcess>();
  private batches = new Map<string, { scope: TestScope; remaining: string[] }>();
  private closing = false;
  private interrupted = new Set<string>();
  constructor(@Inject(WorkStore) readonly store: WorkStore, @Inject(LegacyService) readonly legacy: LegacyService) {
    for (const work of store.list()) for (const record of store.records(work.id, 'verification').filter(x => x.status === 'running')) store.record(record.id, work.id, 'verification', { ...record, status: 'interrupted', error: '서버 재시작으로 검증 결과를 확인할 수 없습니다' });
  }
  snapshot(work: Work): Snapshot { return collectFiles(this.executionPath(work)); }
  revision(work: Work) { return snapshotRevision(this.snapshot(work)); }
  baseline(work: Work) { this.prepare(work); }
  changes(work: Work) { return this.changeReport(work).files; }
  commands(work: Work, scope: TestScope = 'full'): VerificationCommand[] {
    if (scope === 'work') return Array.isArray(work.workVerificationCommands) ? work.workVerificationCommands as VerificationCommand[] : relatedTestCommands(work.executionPath || work.projectPath, this.changes(work).map((file: { path: string }) => file.path));
    if (['completed', 'archived'].includes(work.phase) && Array.isArray(work.completedCommands)) return work.completedCommands as VerificationCommand[];
    if (Array.isArray(work.verificationCommands)) return work.verificationCommands as VerificationCommand[];
    const pkg = join(work.executionPath && !['completed', 'archived'].includes(work.phase) ? this.executionPath(work) : work.projectPath, 'package.json');
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
  results(work: Work, capturedRevision?: string) {
    let revision: string | null = null;
    try { revision = ['completed', 'archived'].includes(work.phase) ? this.store.records(work.id, 'completed-changes')[0]?.report?.revision ?? null : this.revision(work); } catch { /* Missing historical isolation is not a current result. */ }
    if (capturedRevision) revision = capturedRevision;
    const commands = { full: this.commands(work), work: this.commands(work, 'work') };
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
    if (!['work', 'full'].includes(scope)) throw new BadRequestException('잘못된 테스트 범위입니다');
    projectCoordinator(this.store).assertWorkCanStart(work);
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
  onModuleDestroy() { this.closing = true; for (const child of this.children.values()) child.kill(); this.children.clear(); }
}
