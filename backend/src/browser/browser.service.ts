import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { WorkStore, type Work } from '../work/store';
import { FileResults } from '../work/file-results';
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
import { VerificationSnapshots, type VerificationSnapshot } from './verification-snapshot';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Active = { workId: string; child?: ChildProcess; cancelled: boolean; abort: AbortController; done: Promise<void> };
@Injectable()
export class BrowserService implements OnModuleDestroy, OnModuleInit {
  readonly mailbox: BrowserMailbox;
  private active?: Active;
  private closing = false;
  private readonly snapshots: VerificationSnapshots;
  private contexts = new Map<string, (id: string) => unknown>();
  private identities = new Map<string, Promise<any>>();
  constructor(@Inject(WorkStore) readonly store: WorkStore) {
    this.snapshots = new VerificationSnapshots(store);
    desktopHealth(store).register('browser', work => this.active?.workId === work.id ? 'active' : store.records(work.id, 'browser-verification').some(row => row.cleanupStatus === 'uncertain') ? 'unknown' : undefined);
    this.mailbox = new BrowserMailbox(store, (id, input) => this.tool(id, input));
    for (const work of store.list().filter(work => !['completed', 'archived'].includes(work.phase))) for (const row of store.records(work.id, 'browser-verification').filter(row => row.status === 'running')) {
      store.record(row.id, work.id, 'browser-verification', { ...row, status: 'interrupted', snapshotStatus: row.snapshotRoot ? 'retained' : row.snapshotStatus, error: '서버 재시작으로 검증 결과를 확인할 수 없습니다' });
      if (work.state === 'running' && row.owner === 'user') { work.state = 'interrupted'; store.save(work); }
    }
  }
  setExecutionContextProvider(name: string, provider: (id: string) => unknown) { this.contexts.set(name, provider); }
  onModuleInit() { for (const work of this.store.list().filter(work => work.browserScenario)) try { this.mailbox.prepare(work); } catch { /* Unavailable work stays unavailable. */ } this.mailbox.start(); }
  private work(id: string) { const work = this.store.get(id); if (!work) throw new NotFoundException('업무를 찾을 수 없습니다'); return work; }
  private context(work: Work) { return { scenarioVersion: digest(work.browserScenario), sourceMutationVersion: work.sourceMutationVersion ?? null, threadId: work.threadId, turnId: work.turnId ?? null, executionContext: digest([...this.contexts].map(([name, provider]) => [name, provider(work.id)])) }; }
  async identity(work: Work) {
    const root = new FileResults(this.store).path(work), revision = await this.snapshots.revision(root);
    const latest = this.work(work.id);
    if (new FileResults(this.store).path(latest) !== root) throw new ConflictException('검증 중 업무 실행 경로가 변경됐습니다');
    return { revision, ...this.context(latest) };
  }
  activity(id: string) { this.work(id); return { running: this.active?.workId === id, busy: !!this.active }; }
  async status(id: string, independent = false) {
    this.work(id);
    let current: Awaited<ReturnType<BrowserService['identity']>> | undefined;
    const rows = this.store.records(id, 'browser-verification').slice(-10);
    if (rows.length) {
      let pending = independent ? this.identity(this.work(id)) : this.identities.get(id);
      if (!pending) { pending = this.identity(this.work(id)); this.identities.set(id, pending); void pending.finally(() => { if (this.identities.get(id) === pending) this.identities.delete(id); }).catch(() => {}); }
      try { current = await pending; } catch { /* Historical/unavailable work is never fresh. */ }
    }
    const context = this.context(this.work(id));
    // Live connection ownership matters during execution, not after a normal turn completes.
    const results = this.store.records(id, 'browser-verification').slice(-10).map(row => ({ ...row, fresh: !!current && current.revision === row.revision && Object.keys(context).filter(key => key !== 'executionContext').every(key => (current as any)[key] === (context as any)[key] && row[key] === (context as any)[key]) }));
    return { scenario: this.work(id).browserScenario ?? null, ...this.activity(id), results };
  }
  save(id: string, input: unknown) {
    const work = this.work(id);
    if (!['implementation', 'verification'].includes(work.phase) || !['idle', 'failed', 'interrupted'].includes(work.state) || this.active || this.closing) throw new ConflictException('실행을 마친 구현·검증 업무에서 시나리오를 등록해 주세요');
    new FileResults(this.store).path(work); projectCoordinator(this.store).assertWorkCanStart(work);
    try { work.browserScenario = parseScenario(input); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '잘못된 시나리오입니다'); }
    this.mailbox.prepare(work); this.store.save(work); this.store.event(id, 'browser-plan-saved', {}); return this.status(id);
  }
  async assertPassed(work: Work) {
    if (!work.browserScenario) return;
    // A completion/apply gate must start its own scan after the request, never
    // borrow a polling scan which may have read the source before this request.
    const latest = (await this.status(work.id, true)).results.at(-1);
    if (!latest?.fresh || latest.status !== 'passed') throw new ConflictException('현재 코드와 시나리오의 브라우저 검증을 통과해야 합니다');
  }
  run(id: string, owner: 'user' | 'tool' = 'user') {
    desktopHealth(this.store).assertExecutionAllowed();
    const work = this.work(id);
    if (this.active || this.closing) throw new ConflictException('다른 브라우저 검증이 진행 중이거나 종료 중입니다');
    if (this.store.list().some(item => this.store.records(item.id, 'browser-verification').some(row => row.cleanupStatus === 'uncertain'))) throw new ConflictException('이전 검증 프로세스의 종료 확인이 필요합니다');
    if (!['implementation', 'verification'].includes(work.phase) || !(owner === 'tool' ? work.state === 'running' : ['idle', 'failed', 'interrupted'].includes(work.state))) throw new ConflictException('현재 업무 상태에서는 검증을 실행할 수 없습니다');
    if (this.store.records(id, 'question').some(unresolvedQuestion)) throw new ConflictException('남아 있는 질문·승인을 먼저 처리해 주세요');
    projectCoordinator(this.store).assertActivityCanStart(work);
    const files = new FileResults(this.store); files.assertSourcePlan(work); const root = files.path(work);
    let scenario: Scenario; try { scenario = parseScenario(work.browserScenario); } catch { throw new BadRequestException('사용자가 브라우저 시나리오를 먼저 등록해야 합니다'); }
    const row: any = { id: randomUUID(), ...this.context(work), workId: id, owner, snapshotStatus: 'preparing', status: 'running', steps: [], createdAt: new Date().toISOString() };
    let resolveDone!: () => void;
    // Reserve synchronously, before any async copy. Cancellation works while preparing.
    const active: Active = this.active = { workId: id, cancelled: false, abort: new AbortController(), done: new Promise<void>(resolve => { resolveDone = resolve; }) };
    this.store.record(row.id, id, 'browser-verification', row);
    if (owner === 'user') { work.state = 'running'; work.phase = 'verification'; this.store.save(work); }
    this.store.event(id, 'browser-started', { id: row.id });
    const started = Date.now(); let snapshot: VerificationSnapshot | undefined, guard: ReturnType<typeof guardBrowserProcess> | undefined, result: BrowserOutcome | undefined, finished = false;
    const finish = async () => {
      if (finished) return; finished = true; clearTimeout(timer);
      let cleaned = true;
      if (guard) try { await (await guard).done; } catch { cleaned = false; }
      const final: any = { ...row, ...(result || { status: active.cancelled ? 'interrupted' : 'blocked', error: '실행 결과를 확인하지 못했습니다. 입력을 자동 반복하지 않습니다' }), durationMs: Date.now() - started };
      if (active.cancelled) final.status = 'interrupted';
      if (snapshot) {
        if (!active.cancelled) try {
          const latest = this.work(id); new FileResults(this.store).assertSourcePlan(latest);
          if (!await this.snapshots.matches(snapshot, new FileResults(this.store).path(latest), active.abort.signal) || Object.keys(this.context(this.work(id))).some(key => (this.context(this.work(id)) as any)[key] !== row[key])) { final.status = 'stale'; final.error = '검증 중 원본·사본·시나리오 또는 대화 실행이 변경됐습니다'; }
        } catch { final.status = 'stale'; final.error = '검증 대상의 최신 상태를 확인하지 못했습니다'; }
        if (cleaned) try { await this.snapshots.cleanup(snapshot); final.snapshotStatus = 'removed'; } catch { final.status = 'blocked'; final.snapshotStatus = 'retained'; final.error = '검증 사본 정리를 확인하지 못해 보존했습니다'; }
        else final.snapshotStatus = 'retained';
      } else final.snapshotStatus = 'unavailable';
      if (active.cancelled && final.snapshotStatus !== 'retained') { final.status = 'interrupted'; final.error = '검증이 중단됐습니다. 입력을 자동 반복하지 않습니다'; }
      if (!cleaned) { final.status = 'blocked'; final.cleanupStatus = 'uncertain'; final.error = '프로세스 소유권 또는 정리를 확인하지 못했습니다. 검증 사본을 보존합니다'; }
      this.store.record(row.id, id, 'browser-verification', final);
      if (owner === 'user') { const latest = this.work(id); if (latest.state === 'running' && latest.threadId === row.threadId && (latest.turnId ?? null) === row.turnId && this.context(latest).executionContext === row.executionContext) { latest.state = active.cancelled ? 'interrupted' : 'idle'; this.store.save(latest); } }
      if (this.active === active) this.active = undefined;
      this.store.event(id, 'browser-finished', { id: row.id, status: final.status }); resolveDone();
    };
    const stop = async () => { active.abort.abort(); if (active.child) { try { await stopOwnedProcess(active.child); } catch { /* Job guard remains authoritative. */ } await finish(); } };
    const timer = setTimeout(() => { active.cancelled = true; void stop(); }, 130000);
    void (async () => {
      try {
        snapshot = await this.snapshots.prepare(work, root, active.abort.signal);
        row.environmentId = snapshot.id; row.snapshotRoot = snapshot.root; row.revision = snapshot.revision; row.snapshotStatus = 'ready';
        this.store.record(row.id, id, 'browser-verification', row);
        active.abort.signal.throwIfAborted();
        if (Object.keys(this.context(this.work(id))).some(key => (this.context(this.work(id)) as any)[key] !== row[key])) throw new ConflictException('사본 준비 중 검증 실행 컨텍스트가 변경됐습니다');
        const source = existsSync(join(__dirname, 'browser-worker.js')) ? join(__dirname, 'browser-worker.js') : join(__dirname, 'browser-worker.ts');
        const env: NodeJS.ProcessEnv = { OPENSPEC_BROWSER_DIRECTORY: browserDirectory() };
        for (const key of ['SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT', 'PATH', 'Path']) if (process.env[key]) env[key] = process.env[key];
        const runtime = localRuntimeDirectory(); if (runtime) env.OPENSPEC_NODE_DIRECTORY = runtime;
        const child = active.child = fork(source, [], { execPath: process.execPath, execArgv: source.endsWith('.ts') ? ['--import', pathToFileURL(require.resolve('tsx')).href] : [], env, silent: true, windowsHide: true });
        guard = guardBrowserProcess(child);
        child.on('message', (message: any) => {
          if (message?.step) { row.steps.push(message.step); this.store.record(row.id, id, 'browser-verification', row); this.store.event(id, 'browser-step', message.step); }
          if (message?.result) result = message.result;
        });
        child.once('error', () => { void finish(); }); child.once('exit', () => { void finish(); });
        child.stdout?.resume(); child.stderr?.resume();
        await guard;
        active.abort.signal.throwIfAborted();
        child.send({ scenario, root: snapshot.root }, error => { if (error) void stop(); });
      } catch (error) {
        row.error = error instanceof Error ? error.message : '검증 사본 준비에 실패했습니다';
        result = { status: active.cancelled ? 'interrupted' : 'blocked', error: row.error, steps: [], viewport: { width: 1280, height: 800 }, consoleErrors: 0 };
        if (active.child) await stop(); else await finish();
      }
    })();
    return { id: row.id, status: 'running' };
  }
  async cancel(id: string) {
    this.work(id); const active = this.active;
    if (!active || active.workId !== id) return { requested: false };
    active.cancelled = true; active.abort.abort();
    if (active.child?.connected) active.child.send({ cancel: true }, () => {});
    const timer = setTimeout(() => { if (active.child) void stopOwnedProcess(active.child).catch(() => {}); }, 5000);
    await active.done; clearTimeout(timer); return { requested: true };
  }
  async tool(id: string, input: any) {
    if (!input || !['run', 'status', 'cancel'].includes(input.op) || Object.keys(input).some(key => key !== 'op')) throw new BadRequestException('등록 시나리오의 run/status/cancel만 사용할 수 있습니다');
    if (input.op === 'run') { this.run(id, 'tool'); await this.active?.done; }
    if (input.op === 'cancel') { await this.cancel(id); return { ...this.activity(id), scenarioName: (this.work(id).browserScenario as Scenario | undefined)?.name, result: { ...this.store.records(id, 'browser-verification').at(-1), fresh: false } }; }
    const status = await this.status(id);
    return { running: status.running, scenarioName: (status.scenario as Scenario | null)?.name, result: status.results.at(-1) ?? null };
  }
  async onModuleDestroy() { this.closing = true; this.mailbox.close(); if (this.active) await this.cancel(this.active.workId); }
}
