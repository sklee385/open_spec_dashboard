import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { WorkStore, type Work } from '../work/store';
import { ProjectResolver } from '../projects/resolver';
import { LegacyService } from '../legacy/legacy.service';
import { inspectWorkspacePath } from '../work/workspace-paths';
import { VerificationEnvironments } from './verification-environment';
import { BrowserFreshness, browserDigest, browserEvidenceValid } from './browser-freshness';
import { BrowserExecutionContexts, type BrowserExecutionContext } from './browser-execution-context';
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
type Active = { workId: string; row: any; candidateId?: string; child?: ChildProcess; cancelled: boolean; abort: AbortController; done: Promise<void> };
@Injectable()
export class BrowserService implements OnModuleDestroy, OnModuleInit {
  readonly mailbox: BrowserMailbox;
  private active?: Active;
  private closing = false;
  private readonly snapshots: VerificationSnapshots;
  private contexts = new Map<string, (id: string) => unknown>();
  private environments?: VerificationEnvironments;
  private ownedLegacy?: LegacyService;
  private bindings?: BrowserExecutionContexts;
  constructor(@Inject(WorkStore) readonly store: WorkStore, @Optional() @Inject(ProjectResolver) private resolver?: ProjectResolver) {
    this.snapshots = new VerificationSnapshots(store);
    desktopHealth(store).register('browser', work => this.active?.workId === work.id ? 'active' : store.records(work.id, 'browser-verification').some(row => row.cleanupStatus === 'uncertain') ? 'unknown' : undefined);
    this.mailbox = new BrowserMailbox(store, (id, input, context) => this.tool(id, input, context), { resolver: () => this.targetResolver(), contexts: () => this.executionBindings() });
    for (const work of store.list().filter(work => !['completed', 'archived'].includes(work.phase))) for (const row of store.records(work.id, 'browser-verification').filter(row => row.status === 'running')) {
      store.record(row.id, work.id, 'browser-verification', { ...row, status: 'interrupted', snapshotStatus: row.snapshotRoot ? 'retained' : row.snapshotStatus, error: '서버 재시작으로 검증 결과를 확인할 수 없습니다' });
      if (work.state === 'running' && row.owner === 'user') { work.state = 'interrupted'; store.save(work); }
    }
  }
  setExecutionContextProvider(name: string, provider: (id: string) => unknown) { this.contexts.set(name, provider); }
  onModuleInit() { for (const work of this.store.list().filter(work => work.browserScenario)) try { this.mailbox.prepare(work); } catch { /* Unavailable work stays unavailable. */ } this.mailbox.start(); }
  private work(id: string) { const work = this.store.get(id); if (!work) throw new NotFoundException('업무를 찾을 수 없습니다'); return work; }
  private targetResolver() { return this.resolver ??= new ProjectResolver(this.ownedLegacy ??= new LegacyService(), this.store); }
  private targetEnvironments() { return this.environments ??= new VerificationEnvironments(this.store, this.targetResolver()); }
  private executionBindings() { return this.bindings ??= new BrowserExecutionContexts(this.store, this.targetResolver(), work => this.context(work).executionContext); }
  private context(work: Work) { return { scenarioVersion: digest(work.browserScenario), sourceMutationVersion: work.sourceMutationVersion ?? null, threadId: work.threadId, turnId: work.turnId ?? null, executionContext: digest([...this.contexts].map(([name, provider]) => [name, provider(work.id)])) }; }
  async identity(work: Work) {
    const { environment } = await this.targetEnvironments().capture({ sourceId: work.sourceId, workId: work.id });
    return { revision: environment.sourceRevision, targetVersion: environment.targetVersion, ...this.context(this.work(work.id)) };
  }
  activity(id: string, candidateId?: string) {
    this.work(id); const active = this.active;
    return { running: active?.workId === id && (active.candidateId ?? null) === (candidateId ?? null), busy: !!active,
      live: active?.workId === id ? { id: active.row.id, workId: id, candidateId: active.candidateId ?? null, targetKind: active.row.targetKind, environmentId: active.row.environmentId ?? null, status: 'running' } : null };
  }
  private rows(id: string, candidateId?: string): any[] {
    const namespace = candidateId === undefined ? "json_extract(data,'$.candidateId') IS NULL" : "json_extract(data,'$.candidateId') = ?";
    const statement = this.store.db.prepare(`SELECT id,data FROM records WHERE work_id=? AND kind='browser-verification' AND ${namespace} ORDER BY rowid DESC LIMIT 10`);
    return (statement.all(id, ...(candidateId === undefined ? [] : [candidateId])) as { id: string; data: string }[]).reverse().map(row => ({ ...JSON.parse(row.data), id: row.id, workId: id }));
  }
  evidenceVersion(id: string, candidateId?: string) { return browserDigest(this.rows(id, candidateId)); }
  async capturePassedProof(id: string, candidateId?: string) {
    this.work(id); const rows = this.rows(id, candidateId), latest = rows.at(-1), recordsVersion = browserDigest(rows);
    if (!browserEvidenceValid(latest)) throw new ConflictException('대상별 최신 브라우저 빌드·환경·종료 통과 근거가 필요합니다');
    const current = await new BrowserFreshness(this.store, this.targetResolver()).capture(id, candidateId);
    if (latest.freshnessEvidence.semanticVersion !== current.version) throw new ConflictException('브라우저 검증 뒤 실제 입력·계획·설정 또는 후보 기준이 변경되었습니다');
    const assertUnchanged = () => { current.assertUnchanged(); if (this.evidenceVersion(id, candidateId) !== recordsVersion) throw new ConflictException('브라우저 관측 뒤 새 결과가 기록되었습니다'); };
    assertUnchanged(); return { row: latest, current, recordsVersion, assertUnchanged };
  }
  async status(id: string, inspect = false, candidateId?: string) {
    const work = this.work(id), rows = this.rows(id, candidateId);
    let observation: any = { state: 'not-checked' }, proof: Awaited<ReturnType<BrowserService['capturePassedProof']>> | undefined;
    if (inspect) try { proof = await this.capturePassedProof(id, candidateId); if (browserDigest(rows) !== proof.recordsVersion) throw new ConflictException('조회 중 브라우저 결과가 변경되었습니다'); proof.assertUnchanged(); observation = { state: 'fresh', checkedAt: new Date().toISOString() }; }
    catch (error: any) { proof = undefined; observation = { state: rows.length ? 'stale' : 'not-run', checkedAt: new Date().toISOString(), reason: error.message }; }
    const results = rows.map(row => ({ ...row, fresh: !!proof && row.id === proof.row.id, freshnessState: inspect ? proof && row.id === proof.row.id ? 'fresh' : 'stale' : 'not-checked' }));
    return { scenario: work.browserScenario ?? null, targetKind: candidateId ? 'integration-candidate' : 'work', candidateId: candidateId ?? null, ...this.activity(id, candidateId), observation, results };
  }
  save(id: string, input: unknown) {
    const work = this.work(id);
    if (!['implementation', 'verification'].includes(work.phase) || !['idle', 'failed', 'interrupted'].includes(work.state) || this.active || this.closing) throw new ConflictException('실행을 마친 구현·검증 업무에서 시나리오를 등록해 주세요');
    this.targetResolver().resolve(work.sourceId, work.id); projectCoordinator(this.store).assertWorkCanStart(work);
    try { work.browserScenario = parseScenario(input); } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '잘못된 시나리오입니다'); }
    this.store.save(work); this.mailbox.prepare(work); this.store.event(id, 'browser-plan-saved', {}); return this.status(id);
  }
  async assertPassed(work: Work) {
    if (!work.browserScenario) return;
    // A completion/apply gate must start its own scan after the request, never
    // borrow a polling scan which may have read the source before this request.
    const proof = await this.capturePassedProof(work.id); proof.assertUnchanged();
  }
  run(id: string, owner: 'user' | 'tool' = 'user', candidateId?: string, binding?: BrowserExecutionContext) {
    desktopHealth(this.store).assertExecutionAllowed();
    const work = this.work(id);
    if (this.active || this.closing) throw new ConflictException('다른 브라우저 검증이 진행 중이거나 종료 중입니다');
    if (this.store.list().some(item => this.store.records(item.id, 'browser-verification').some(row => row.cleanupStatus === 'uncertain'))) throw new ConflictException('이전 검증 프로세스의 종료 확인이 필요합니다');
    if (!['implementation', 'verification'].includes(work.phase) || !(owner === 'tool' ? work.state === 'running' : ['idle', 'failed', 'interrupted'].includes(work.state))) throw new ConflictException('현재 업무 상태에서는 검증을 실행할 수 없습니다');
    if (this.store.records(id, 'question').some(unresolvedQuestion)) throw new ConflictException('남아 있는 질문·승인을 먼저 처리해 주세요');
    projectCoordinator(this.store).assertActivityCanStart(work);
    new FileResults(this.store).assertSourcePlan(work);
    const selected = this.targetResolver().resolve(work.sourceId, work.id, candidateId), root = selected.root;
    const executionBinding = owner === 'user' ? this.executionBindings().select(id, candidateId) : binding ?? this.executionBindings().current(id);
    if ((executionBinding.candidateId ?? undefined) !== candidateId) throw new ConflictException('호스트가 승인한 검증 대상과 다릅니다');
    this.executionBindings().assertRun(executionBinding);
    let scenario: Scenario; try { scenario = parseScenario(work.browserScenario); } catch { throw new BadRequestException('사용자가 브라우저 시나리오를 먼저 등록해야 합니다'); }
    const row: any = { id: randomUUID(), ...this.context(work), workId: id, owner, executionBinding, ...(executionBinding.requestId ? { requestKey: executionBinding.requestId, mailboxRequestId: executionBinding.requestId } : {}), candidateId: candidateId ?? null, targetKind: candidateId ? 'integration-candidate' : 'work', snapshotStatus: 'preparing', status: 'running', steps: [], createdAt: new Date().toISOString() };
    let resolveDone!: () => void;
    // Reserve synchronously, before any async copy. Cancellation works while preparing.
    const active: Active = this.active = { workId: id, row, candidateId, cancelled: false, abort: new AbortController(), done: new Promise<void>(resolve => { resolveDone = resolve; }) };
    this.store.record(row.id, id, 'browser-verification', row);
    if (owner === 'user') { work.state = 'running'; work.phase = 'verification'; this.store.save(work); }
    this.store.event(id, 'browser-started', { id: row.id });
    const started = Date.now(); let snapshot: VerificationSnapshot | undefined, guard: ReturnType<typeof guardBrowserProcess> | undefined, result: BrowserOutcome | undefined, finished = false;
    let environmentProof: Awaited<ReturnType<VerificationEnvironments['capture']>> | undefined;
    let initialBasis: Awaited<ReturnType<BrowserFreshness['capture']>> | undefined, childTerminated = false;
    const finish = async () => {
      if (finished) return; finished = true; clearTimeout(timer);
      let cleaned = true;
      if (guard) try { await (await guard).done; } catch { cleaned = false; }
      const final: any = { ...row, ...(result || { status: active.cancelled ? 'interrupted' : 'blocked', error: '실행 결과를 확인하지 못했습니다. 입력을 자동 반복하지 않습니다' }), durationMs: Date.now() - started };
      if (final.status === 'passed' && !result?.buildAttestation) { final.status = 'blocked'; final.error = '새 빌드와 실제 서버 응답의 출처 확인이 없습니다'; }
      if (active.cancelled) final.status = 'interrupted';
      if (snapshot) {
        if (!active.cancelled) try {
          new FileResults(this.store).assertSourcePlan(this.work(id)); await environmentProof!.assertCurrent();
          if ((!await this.snapshots.matches(snapshot, root, active.abort.signal, result?.buildAttestation?.outputs) && final.status !== 'blocked') || Object.keys(this.context(this.work(id))).some(key => (this.context(this.work(id)) as any)[key] !== row[key])) { final.status = 'stale'; final.error = '검증 중 원본·사본·시나리오 또는 대화 실행이 변경됐습니다'; }
        } catch { final.status = 'stale'; final.error = '검증 대상의 최신 상태를 확인하지 못했습니다'; }
        if (cleaned) try { await this.snapshots.cleanup(snapshot); final.snapshotStatus = 'removed'; } catch { final.status = 'blocked'; final.snapshotStatus = 'retained'; final.error = '검증 사본 정리를 확인하지 못해 보존했습니다'; }
        else final.snapshotStatus = 'retained';
      } else final.snapshotStatus = 'unavailable';
      if (active.cancelled && final.snapshotStatus !== 'retained') { final.status = 'interrupted'; final.error = '검증이 중단됐습니다. 입력을 자동 반복하지 않습니다'; }
      if (!cleaned) { final.status = 'blocked'; final.cleanupStatus = 'uncertain'; final.error = '프로세스 소유권 또는 정리를 확인하지 못했습니다. 검증 사본을 보존합니다'; }
      if (final.image && environmentProof) try {
        const directory = environmentProof.environment.evidencePath; inspectWorkspacePath(directory, []);
        const path = join(directory, `${row.id}.jpg`); await writeFile(path, Buffer.from(final.image.slice('data:image/jpeg;base64,'.length), 'base64'), { flag: 'wx' }); final.evidencePath = path;
      } catch { final.status = 'blocked'; final.error = '호스트 증거 경로에 화면을 보존하지 못했습니다'; }
      final.processTerminated = cleaned && (!active.child || childTerminated);
      if (final.status === 'passed') try {
        if (!guard || !childTerminated || !final.processTerminated || !initialBasis) throw new Error('부모 실행기의 실제 종료 확인이 없습니다');
        const current = await new BrowserFreshness(this.store, this.targetResolver()).capture(id, candidateId);
        if (current.version !== initialBasis.version) throw new Error('검증 중 실제 입력 또는 후보 기준이 변경되었습니다');
        final.freshnessEvidence = { version: 1, runId: row.id, environmentId: row.environmentId, rawSourceRevision: row.environment.sourceRevision, executedCommit: row.environment.commit, buildId: result!.buildAttestation!.buildId, basis: initialBasis.basis, semanticVersion: initialBasis.version };
        if (!browserEvidenceValid(final)) throw new Error('실제 빌드·환경 근거의 연결을 확인할 수 없습니다');
      } catch (error: any) { final.status = 'stale'; final.error = error.message; delete final.freshnessEvidence; }
      if (!active.cancelled && !this.executionBindings().isCurrent(executionBinding)) { final.status = 'stale'; final.error = '검증 대상 또는 대화 실행 컨텍스트가 변경됐습니다'; delete final.freshnessEvidence; }
      if (active.cancelled) { final.status = 'interrupted'; delete final.freshnessEvidence; }
      this.store.record(row.id, id, 'browser-verification', final);
      if (owner === 'user') { const latest = this.work(id); if (latest.state === 'running' && latest.threadId === row.threadId && (latest.turnId ?? null) === row.turnId && this.context(latest).executionContext === row.executionContext) { latest.state = active.cancelled ? 'interrupted' : 'idle'; this.store.save(latest); } }
      if (this.active === active) this.active = undefined;
      this.store.event(id, 'browser-finished', { id: row.id, status: final.status }); resolveDone();
    };
    const stop = async () => { active.abort.abort(); if (active.child) { try { await stopOwnedProcess(active.child); } catch { /* Job guard remains authoritative. */ } await finish(); } };
    const timer = setTimeout(() => { active.cancelled = true; void stop(); }, 130000);
    void (async () => {
      try {
        this.executionBindings().assertRun(executionBinding);
        environmentProof = await this.targetEnvironments().capture({ sourceId: work.sourceId, workId: id, ...(candidateId ? { candidateId } : {}) });
        const environment = environmentProof.environment;
        initialBasis = await new BrowserFreshness(this.store, this.targetResolver()).capture(id, candidateId);
        if (environment.executionPath !== root) throw new ConflictException('검증 대상 경로가 변경됐습니다');
        snapshot = await this.snapshots.prepare(this.work(id), root, active.abort.signal, environment); await environmentProof.assertCurrent();
        Object.assign(row, { environmentId: environment.environmentId, environment, targetVersion: environment.targetVersion, build: environment.build }); row.snapshotRoot = snapshot.root; row.revision = snapshot.revision; row.snapshotStatus = 'ready';
        this.store.record(row.id, id, 'browser-verification', row);
        active.abort.signal.throwIfAborted();
        if (Object.keys(this.context(this.work(id))).some(key => (this.context(this.work(id)) as any)[key] !== row[key])) throw new ConflictException('사본 준비 중 검증 실행 컨텍스트가 변경됐습니다');
        this.executionBindings().assertRun(executionBinding);
        const source = existsSync(join(__dirname, 'browser-worker.js')) ? join(__dirname, 'browser-worker.js') : join(__dirname, 'browser-worker.ts');
        const env: NodeJS.ProcessEnv = { OPENSPEC_BROWSER_DIRECTORY: browserDirectory(), OPENSPEC_VERIFICATION_DATA_ROOT: resolve(process.env.DATA_DIR || '../.data') };
        for (const key of ['SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT', 'PATH', 'Path']) if (process.env[key]) env[key] = process.env[key];
        const runtime = localRuntimeDirectory(); if (runtime) env.OPENSPEC_NODE_DIRECTORY = runtime;
        const child = active.child = fork(source, [], { execPath: process.execPath, execArgv: source.endsWith('.ts') ? ['--import', pathToFileURL(require.resolve('tsx')).href] : [], env, silent: true, windowsHide: true });
        guard = guardBrowserProcess(child);
        child.on('message', (message: any) => {
          if (message?.step) { row.steps.push(message.step); this.store.record(row.id, id, 'browser-verification', row); this.store.event(id, 'browser-step', message.step); }
          if (message?.result) result = message.result;
        });
        child.once('error', () => { void finish(); }); child.once('exit', () => { childTerminated = true; void finish(); });
        child.stdout?.resume(); child.stderr?.resume();
        await guard;
        active.abort.signal.throwIfAborted();
        this.executionBindings().assertRun(executionBinding);
        child.send({ scenario, root: snapshot.root, snapshot, environment }, error => { if (error) void stop(); });
      } catch (error) {
        row.error = error instanceof Error ? error.message : '검증 사본 준비에 실패했습니다';
        result = { status: active.cancelled ? 'interrupted' : 'blocked', error: row.error, steps: [], viewport: { width: 1280, height: 800 }, consoleErrors: 0 };
        if (active.child) await stop(); else await finish();
      }
    })();
    return { id: row.id, status: 'running' };
  }
  async cancel(id: string, expected?: { contextId: string; runId?: string; candidateId: string | null }) {
    this.work(id); const active = this.active;
    if (!active || active.workId !== id) return { requested: false };
    if (expected && (active.row.executionBinding?.contextId !== expected.contextId || (active.candidateId ?? null) !== expected.candidateId || expected.runId && active.row.id !== expected.runId)) return { requested: false };
    active.cancelled = true; active.abort.abort();
    if (active.child?.connected) active.child.send({ cancel: true }, () => {});
    const timer = setTimeout(() => { if (active.child) void stopOwnedProcess(active.child).catch(() => {}); }, 5000);
    await active.done; clearTimeout(timer); return { requested: true };
  }
  private receipt(id: string, runId: string) {
    const row = this.store.db.prepare("SELECT id,data FROM records WHERE id=? AND work_id=? AND kind='browser-verification'").get(runId, id) as { id: string; data: string } | undefined;
    return row ? { ...JSON.parse(row.data), id: row.id, workId: id } : undefined;
  }
  private async completedRun(id: string, runId: string) {
    // Capture this promise before any await; never follow a later global active run.
    const done = this.active?.workId === id && this.active.row.id === runId ? this.active.done : undefined;
    if (done) await done;
    return this.receipt(id, runId);
  }
  private boundResult(context: BrowserExecutionContext, runId?: string) {
    const matches = (row: any) => row && (row.candidateId ?? null) === context.candidateId && (row.executionBinding ? row.executionBinding.contextId === context.contextId : row.threadId === context.threadId && (row.turnId ?? null) === context.turnId && row.scenarioVersion === context.scenarioVersion);
    if (runId) { const row = this.receipt(context.workId, runId); return matches(row) ? row : undefined; }
    return this.rows(context.workId, context.candidateId ?? undefined).filter(matches).at(-1);
  }
  async tool(id: string, input: any, bound?: BrowserExecutionContext) {
    if (!input || !['run', 'status', 'cancel'].includes(input.op) || Object.keys(input).some(key => key !== 'op')) throw new BadRequestException('등록 시나리오의 run/status/cancel만 사용할 수 있습니다');
    const context = bound ? { ...this.executionBindings().load(id, bound.contextId), ...(bound.requestId ? { requestId: bound.requestId } : {}) } : this.executionBindings().current(id);
    let runId: string | undefined, requested: boolean | undefined;
    if (input.op === 'run') {
      this.executionBindings().assertRun(context);
      const started = this.run(id, 'tool', context.candidateId ?? undefined, context), startedId = started.id;
      if (typeof startedId !== 'string' || !startedId) throw new ConflictException('시작한 브라우저 실행 ID를 확인할 수 없습니다');
      runId = startedId; await this.completedRun(id, startedId);
    }
    if (input.op === 'cancel') {
      const active = this.active;
      if (active?.workId === id && active.row.executionBinding?.contextId === context.contextId) runId = active.row.id;
      requested = (await this.cancel(id, { contextId: context.contextId, candidateId: context.candidateId, ...(runId ? { runId } : {}) })).requested;
    }
    const row = this.boundResult(context, runId); let fresh = false, reason: string | undefined;
    if (input.op === 'run' && !row) throw new ConflictException('시작한 브라우저 실행의 정확한 영수증을 확인하지 못했습니다. 자동 반복하지 않습니다');
    let contextChanged = !this.executionBindings().isCurrent(context);
    if (row?.status === 'passed' && !contextChanged && input.op !== 'cancel') try {
      const proof = await this.capturePassedProof(id, context.candidateId ?? undefined); proof.assertUnchanged(); fresh = proof.row.id === row.id;
    } catch (error: any) { reason = error.message; }
    contextChanged ||= !this.executionBindings().isCurrent(context);
    if (contextChanged) fresh = false;
    const result = row ? { ...row, fresh, freshnessState: fresh ? 'fresh' : input.op === 'cancel' ? 'not-checked' : 'stale', ...(reason ? { freshnessReason: reason } : {}) } : null;
    return { ...this.activity(id, context.candidateId ?? undefined), contextId: context.contextId, contextChanged, targetKind: context.targetKind, candidateId: context.candidateId, ...(requested === undefined ? {} : { requested }), runId: result?.id ?? null, scenarioName: (this.work(id).browserScenario as Scenario | undefined)?.name, success: !contextChanged && !(input.op === 'run' && result?.status === 'running') && !(result?.status === 'passed' && !fresh) && !['failed', 'blocked', 'interrupted', 'stale'].includes(result?.status), result };
  }
  async onModuleDestroy() { this.closing = true; this.mailbox.close(); if (this.active) await this.cancel(this.active.workId); await this.ownedLegacy?.onModuleDestroy(); }
}
