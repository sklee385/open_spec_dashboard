import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { WorkStore, type Work } from '../work/store';
import { FileResults, collectFiles, snapshotRevision } from '../work/file-results';
import { projectCoordinator } from '../projects/coordinator';
import { unresolvedQuestion } from '../codex/questions';
import { parseScenario, type Scenario } from './browser-policy';
import { browserDirectory } from './browser-runtime';
import { localRuntimeDirectory } from '../runtime';
import { stopOwnedProcess } from './browser-process';
import type { BrowserOutcome } from './browser-runner';
import { guardBrowserProcess } from './browser-job';
import { BrowserMailbox } from './browser-mailbox';
import { desktopHealth } from '../desktop/health';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
@Injectable()
export class BrowserService implements OnModuleDestroy, OnModuleInit {
  readonly mailbox: BrowserMailbox;
  private active?: { workId: string; child: ChildProcess; cancelled: boolean; done: Promise<void> };
  private closing = false;
  constructor(@Inject(WorkStore) readonly store: WorkStore) {
    desktopHealth(store).register('browser', work => this.active?.workId === work.id ? 'active' : undefined);
    this.mailbox = new BrowserMailbox(store, (id, input) => this.tool(id, input));
    for (const work of store.list().filter(work => !['completed', 'archived'].includes(work.phase))) for (const row of store.records(work.id, 'browser-verification').filter(row => row.status === 'running')) {
      store.record(row.id, work.id, 'browser-verification', { ...row, status: 'interrupted', error: '서버 재시작으로 검증 결과를 확인할 수 없습니다' });
      if (work.state === 'running' && row.owner === 'user') { work.state = 'interrupted'; store.save(work); }
    }
  }
  onModuleInit() { for (const work of this.store.list().filter(work => work.browserScenario)) try { this.mailbox.prepare(work); } catch { /* Unavailable work stays unavailable. */ } this.mailbox.start(); }
  private work(id: string) { const work = this.store.get(id); if (!work) throw new NotFoundException('업무를 찾을 수 없습니다'); return work; }
  identity(work: Work) {
    const root = new FileResults(this.store).path(work);
    return { revision: snapshotRevision(collectFiles(root)), scenarioVersion: digest(work.browserScenario), sourceMutationVersion: work.sourceMutationVersion ?? null };
  }
  status(id: string) {
    const work = this.work(id); let current: ReturnType<BrowserService['identity']> | undefined;
    try { current = this.identity(work); } catch { /* Historical/unavailable work is never fresh. */ }
    const results = this.store.records(id, 'browser-verification').slice(-10).map(row => ({ ...row, fresh: !!current && row.revision === current.revision && row.scenarioVersion === current.scenarioVersion && row.sourceMutationVersion === current.sourceMutationVersion }));
    return { scenario: work.browserScenario ?? null, running: this.active?.workId === id, busy: !!this.active, results };
  }
  save(id: string, input: unknown) {
    const work = this.work(id);
    if (!['implementation', 'verification'].includes(work.phase) || !['idle', 'failed', 'interrupted'].includes(work.state) || this.active || this.closing) throw new ConflictException('실행을 마친 구현·검증 업무에서 시나리오를 등록해 주세요');
    new FileResults(this.store).path(work); projectCoordinator(this.store).assertWorkCanStart(work);
    try { work.browserScenario = parseScenario(input); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '잘못된 시나리오입니다'); }
    this.mailbox.prepare(work); this.store.save(work); this.store.event(id, 'browser-plan-saved', {}); return this.status(id);
  }
  assertPassed(work: Work) {
    if (!work.browserScenario) return;
    const latest = this.status(work.id).results.at(-1);
    if (!latest?.fresh || latest.status !== 'passed') throw new ConflictException('현재 코드와 시나리오의 브라우저 검증을 통과해야 합니다');
  }
  run(id: string, owner: 'user' | 'tool' = 'user') {
    desktopHealth(this.store).assertExecutionAllowed();
    const work = this.work(id);
    if (this.active || this.closing) throw new ConflictException('다른 브라우저 검증이 진행 중이거나 종료 중입니다');
    if (!['implementation', 'verification'].includes(work.phase) || !(owner === 'tool' ? work.state === 'running' : ['idle', 'failed', 'interrupted'].includes(work.state))) throw new ConflictException('현재 업무 상태에서는 검증을 실행할 수 없습니다');
    if (this.store.records(id, 'question').some(unresolvedQuestion)) throw new ConflictException('남아 있는 질문·승인을 먼저 처리해 주세요');
    projectCoordinator(this.store).assertWorkCanStart(work);
    const files = new FileResults(this.store); files.assertSourcePlan(work); const root = files.path(work);
    let scenario: Scenario; try { scenario = parseScenario(work.browserScenario); } catch { throw new BadRequestException('사용자가 브라우저 시나리오를 먼저 등록해야 합니다'); }
    const row: any = { id: randomUUID(), ...this.identity(work), owner, status: 'running', steps: [], createdAt: new Date().toISOString() };
    const source = existsSync(join(__dirname, 'browser-worker.js')) ? join(__dirname, 'browser-worker.js') : join(__dirname, 'browser-worker.ts');
    const env: NodeJS.ProcessEnv = { OPENSPEC_BROWSER_DIRECTORY: browserDirectory() };
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT', 'PATH', 'Path']) if (process.env[key]) env[key] = process.env[key];
    const runtime = localRuntimeDirectory(); if (runtime) env.OPENSPEC_NODE_DIRECTORY = runtime;
    let child: ChildProcess;
    try { child = fork(source, [], { execPath: process.execPath, execArgv: source.endsWith('.ts') ? ['--import', pathToFileURL(require.resolve('tsx')).href] : [], env, silent: true, windowsHide: true }); }
    catch { throw new ConflictException('검증 실행기를 시작하지 못했습니다'); }
    let resolveDone!: () => void;
    const active = this.active = { workId: id, child, cancelled: false as boolean, done: new Promise<void>(resolve => { resolveDone = resolve; }) };
    const guard = guardBrowserProcess(child);
    const started = Date.now(); let result: BrowserOutcome | undefined, failed = false;
    this.store.record(row.id, id, 'browser-verification', row);
    if (owner === 'user') { work.state = 'running'; work.phase = 'verification'; this.store.save(work); }
    this.store.event(id, 'browser-started', { id: row.id });
    const finish = async () => {
      if (failed) return; failed = true; clearTimeout(timer);
      let cleaned = true;
      try { await (await guard).done; } catch { cleaned = false; }
      const final: any = { ...row, ...(result || { status: active.cancelled ? 'interrupted' : 'blocked', error: '실행 결과를 확인하지 못했습니다. 입력을 자동 반복하지 않습니다' }), durationMs: Date.now() - started };
      if (active.cancelled) final.status = 'interrupted';
      if (!cleaned) { final.status = 'blocked'; final.error = '프로세스 소유권 또는 정리를 확인하지 못했습니다. Windows 실행 정책을 확인해 주세요'; }
      try { if (this.identity(this.work(id)).revision !== row.revision) { final.status = 'stale'; final.error = '검증 중 코드가 변경됐습니다'; } } catch { final.status = 'stale'; }
      this.store.record(row.id, id, 'browser-verification', final);
      if (owner === 'user') { const latest = this.work(id); latest.state = active.cancelled ? 'interrupted' : 'idle'; this.store.save(latest); }
      if (this.active === active) this.active = undefined;
      this.store.event(id, 'browser-finished', { id: row.id, status: final.status }); resolveDone();
    };
    const timer = setTimeout(() => { active.cancelled = true; void stopOwnedProcess(child).catch(() => {}).finally(finish); }, 130000);
    child.on('message', (message: any) => {
      if (message?.step) { row.steps.push(message.step); this.store.record(row.id, id, 'browser-verification', row); this.store.event(id, 'browser-step', message.step); }
      if (message?.result) result = message.result;
    });
    child.once('error', finish); child.once('exit', finish);
    child.stdout?.resume(); child.stderr?.resume(); // Never persist server logs or credentials.
    void guard.then(() => child.send({ scenario, root }, error => { if (error) { void stopOwnedProcess(child).catch(() => {}).finally(finish); } })).catch(() => { void stopOwnedProcess(child).catch(() => {}).finally(finish); });
    return { id: row.id, status: 'running' };
  }
  async cancel(id: string) {
    this.work(id); const active = this.active;
    if (!active || active.workId !== id) return { requested: false };
    active.cancelled = true;
    if (active.child.connected) active.child.send({ cancel: true }, () => {});
    const timer = setTimeout(() => { void stopOwnedProcess(active.child).catch(() => {}); }, 5000);
    await active.done; clearTimeout(timer); return { requested: true };
  }
  async tool(id: string, input: any) {
    if (!input || !['run', 'status', 'cancel'].includes(input.op) || Object.keys(input).some(key => key !== 'op')) throw new BadRequestException('등록 시나리오의 run/status/cancel만 사용할 수 있습니다');
    if (input.op === 'run') { this.run(id, 'tool'); await this.active?.done; }
    if (input.op === 'cancel') await this.cancel(id);
    const status = this.status(id);
    return { running: status.running, scenarioName: (status.scenario as Scenario | null)?.name, result: status.results.at(-1) ?? null };
  }
  async onModuleDestroy() { this.closing = true; this.mailbox.close(); if (this.active) await this.cancel(this.active.workId); }
}
