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
import type { BrowserOutcome } from './browser-runner';
import { prepareBrowserWitness, bindBrowserWitness, recoverBrowserWitness } from './browser-witness';
import { guardBrowserProcess } from './browser-job';
import { BrowserMailbox } from './browser-mailbox';
import { desktopHealth } from '../desktop/health';
import { VerificationSnapshots, type VerificationSnapshot } from './verification-snapshot';
import { assertBrowserLease, browserProtocol, browserRecord, browserSettlementMs, browserSlot, browserTerminationValid, checkpointBrowser, claimBrowser, finishBrowserLease, liveBrowser, proofForBrowser, recoverBrowserLease } from './browser-lease';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Active = { workId: string; row: any; candidateId?: string; child?: ChildProcess; cancelled: boolean; abort: AbortController; done: Promise<void>; stop?: () => Promise<void> };
async function settlement<T>(promise: Promise<T>) { let timer: NodeJS.Timeout; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('소유 프로세스 종료 확인 시간이 초과됐습니다')), browserSettlementMs); })]); } finally { clearTimeout(timer!); } }
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
    liveBrowser(store); // Cache actual DB identity outside cheap status polling.
    desktopHealth(store).register('browser', work => {
      const entry = liveBrowser(store, work.id), slot = browserSlot(store);
      if (entry?.phase === 'active') return 'active';
      if (slot?.workId === work.id && slot.status !== 'settled' || store.db.prepare("SELECT 1 FROM records WHERE work_id=? AND kind='browser-verification' AND (json_extract(data,'$.cleanupStatus')='uncertain' OR json_extract(data,'$.status')='running') LIMIT 1").get(work.id)) return 'unknown';
      return undefined;
    });
    this.mailbox = new BrowserMailbox(store, (id, input, context) => this.tool(id, input, context), { resolver: () => this.targetResolver(), contexts: () => this.executionBindings() });
    // A restart never turns an unobserved running PID into a terminated process.
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
    this.work(id); const slot = browserSlot(this.store), entry = liveBrowser(this.store, id), row = slot?.workId === id && slot.status !== 'settled' ? browserRecord(this.store, slot.runId) : undefined, active = entry?.phase === 'active';
    return { running: !!active && (row?.candidateId ?? null) === (candidateId ?? null), busy: !!slot && slot.status !== 'settled',
      live: row && slot.status !== 'settled' ? { id: row.id, workId: id, candidateId: row.candidateId ?? null, targetKind: row.targetKind, environmentId: row.environmentId ?? null, status: active ? 'running' : 'unknown' } : null };
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
    const results = rows.map(row => { const { terminationWitness: _witness, ...receipt } = row; return { ...receipt, fresh: !!proof && row.id === proof.row.id, freshnessState: inspect ? proof && row.id === proof.row.id ? 'fresh' : 'stale' : 'not-checked' }; });
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
  run(id: string, owner: 'user' | 'tool' = 'user', candidateId?: string, binding?: BrowserExecutionContext, httpRequestKey?: string) {
    const previousSlot = browserSlot(this.store); if (previousSlot && previousSlot.status !== 'settled') throw new ConflictException('다른 브라우저 검증이 진행 중이거나 실제 종료 확인이 필요합니다');
    desktopHealth(this.store).assertExecutionAllowed();
    const work = this.work(id);
    if (this.active || this.closing) throw new ConflictException('다른 브라우저 검증이 진행 중이거나 종료 중입니다');
    if (!['implementation', 'verification'].includes(work.phase) || !(owner === 'tool' ? work.state === 'running' : ['idle', 'failed', 'interrupted'].includes(work.state))) throw new ConflictException('현재 업무 상태에서는 검증을 실행할 수 없습니다');
    if (this.store.records(id, 'question').some(unresolvedQuestion)) throw new ConflictException('남아 있는 질문·승인을 먼저 처리해 주세요');
    projectCoordinator(this.store).assertActivityCanStart(work);
    new FileResults(this.store).assertSourcePlan(work);
    const selected = this.targetResolver().resolve(work.sourceId, work.id, candidateId), root = selected.root;
    const executionBinding = owner === 'user' ? this.executionBindings().select(id, candidateId) : binding ?? this.executionBindings().current(id);
    if ((executionBinding.candidateId ?? undefined) !== candidateId) throw new ConflictException('호스트가 승인한 검증 대상과 다릅니다');
    this.executionBindings().assertRun(executionBinding);
    if (owner === 'user' && httpRequestKey) executionBinding.requestId = httpRequestKey;
    let scenario: Scenario; try { scenario = parseScenario(work.browserScenario); } catch { throw new BadRequestException('사용자가 브라우저 시나리오를 먼저 등록해야 합니다'); }
    const row: any = { id: randomUUID(), ...this.context(work), workId: id, owner, executionBinding, ...(executionBinding.requestId ? { requestKey: executionBinding.requestId, ...(owner === 'tool' ? { mailboxRequestId: executionBinding.requestId } : {}) } : {}), candidateId: candidateId ?? null, targetKind: candidateId ? 'integration-candidate' : 'work', snapshotStatus: 'preparing', status: 'running', steps: [], createdAt: new Date().toISOString() };
    const lease = claimBrowser(this.store, row, () => { if (owner === 'user') { work.state = 'running'; work.phase = 'verification'; this.store.save(work); } });
    let resolveDone!: () => void;
    // Reserve synchronously, before any async copy. Cancellation works while preparing.
    const active: Active = this.active = { workId: id, row, candidateId, cancelled: false, abort: new AbortController(), done: new Promise<void>(resolve => { resolveDone = resolve; }) };
    const started = Date.now(); let snapshot: VerificationSnapshot | undefined, guard: ReturnType<typeof guardBrowserProcess> | undefined, handle: Awaited<ReturnType<typeof guardBrowserProcess>> | undefined, result: BrowserOutcome | undefined, finalization: Promise<void> | undefined, closed = false;
    let resolveClosed!: () => void; const childClosed = new Promise<void>(resolve => { resolveClosed = resolve; });
    let resolvePreparation!: () => void, preparationFinished = false; const preparationDone = new Promise<void>(resolve => { resolvePreparation = () => { preparationFinished = true; resolve(); }; });
    let environmentProof: Awaited<ReturnType<VerificationEnvironments['capture']>> | undefined;
    let initialBasis: Awaited<ReturnType<BrowserFreshness['capture']>> | undefined;
    const observeTermination = () => {
      const proof = handle?.terminationProof;
      if (!active.child && preparationFinished) return proofForBrowser(lease, row, { state: 'not-started' });
      if (closed && row.dispatched !== true && (!guard || proof?.protocol === browserProtocol && proof.activeProcesses === 0)) return proofForBrowser(lease, row, { state: 'worker-closed-before-dispatch' });
      if (closed && proof?.protocol === browserProtocol && proof.activeProcesses === 0 && proof.workerPid === row.processId && proof.guardPid === row.guardPid) return proofForBrowser(lease, row, { state: 'job-quiescent', activeProcesses: 0 });
      return undefined;
    };
    const cleanupPermit = () => {
      assertBrowserLease(this.store, lease, row);
      if (!browserTerminationValid(browserRecord(this.store, row.id), browserSlot(this.store), browserRecord(this.store, row.intentId))) throw new ConflictException('현재 소유 Job과 child 종료 근거가 필요합니다');
    };
    const finish = (): Promise<void> => finalization ??= (async () => {
      clearTimeout(timer); let removed = false;
      try {
        // Cancellation during an async copy must wait for its abort/cleanup path;
        // a missing PID alone never proves that preparation has stopped.
        await settlement(preparationDone);
        const outcomes = await Promise.allSettled([
          settlement(guard ? guard.then(async value => { handle = value; row.guardPid = value.pid ?? null; await value.done; lease.proof = observeTermination(); }) : Promise.resolve()),
          settlement(active.child ? childClosed : Promise.resolve()),
        ]);
        row.workerClosed = closed;
        if (outcomes.every(outcome => outcome.status === 'fulfilled')) lease.proof = observeTermination();
        row.processTerminated = !!lease.proof;
        if (lease.proof) row.terminationProof = lease.proof;
        checkpointBrowser(this.store, lease, row);
        if (!lease.proof) throw new Error('소유 Job active=0 및 child close를 확인하지 못했습니다. 사본과 점유를 보존합니다');
        const final: any = { ...row, ...(result || { status: active.cancelled ? 'interrupted' : 'blocked', error: '실행 결과를 확인하지 못했습니다. 입력을 자동 반복하지 않습니다' }), id: row.id, workId: row.workId, owner: row.owner, candidateId: row.candidateId, targetKind: row.targetKind, environment: row.environment, environmentId: row.environmentId, snapshot: row.snapshot, snapshotRoot: row.snapshotRoot, revision: row.revision, targetVersion: row.targetVersion, requestKey: row.requestKey, mailboxRequestId: row.mailboxRequestId, executionBinding: row.executionBinding, executionProtocol: row.executionProtocol, executionOwner: row.executionOwner, runGeneration: row.runGeneration, intentId: row.intentId, processId: row.processId, guardPid: row.guardPid, workerClosed: row.workerClosed, workerSpawned: row.workerSpawned, dispatched: row.dispatched, processTerminated: row.processTerminated, terminationProof: row.terminationProof, terminationWitness: row.terminationWitness, durationMs: Date.now() - started };
        if (final.status === 'passed' && !result?.buildAttestation) { final.status = 'blocked'; final.error = '새 빌드와 실제 서버 응답의 출처 확인이 없습니다'; }
        if (snapshot) {
          if (!active.cancelled) try {
            new FileResults(this.store).assertSourcePlan(this.work(id)); await environmentProof!.assertCurrent();
            if ((!await this.snapshots.matches(snapshot, root, active.abort.signal, result?.buildAttestation?.outputs) && final.status !== 'blocked') || Object.keys(this.context(this.work(id))).some(key => (this.context(this.work(id)) as any)[key] !== row[key])) { final.status = 'stale'; final.error = '검증 중 원본·사본·시나리오 또는 대화 실행이 변경됐습니다'; }
          } catch { final.status = 'stale'; final.error = '검증 대상의 최신 상태를 확인하지 못했습니다'; }
          await this.snapshots.cleanup(snapshot, cleanupPermit); removed = true; final.snapshotStatus = 'removed';
        } else final.snapshotStatus = 'unavailable';
        if (final.image && environmentProof) {
          const directory = environmentProof.environment.evidencePath; inspectWorkspacePath(directory, []);
          const path = join(directory, `${row.id}.jpg`); await writeFile(path, Buffer.from(final.image.slice('data:image/jpeg;base64,'.length), 'base64'), { flag: 'wx' }); final.evidencePath = path;
        }
        if (final.status === 'passed') {
          if (lease.proof.state !== 'job-quiescent' || !initialBasis) throw new Error('부모 실행기의 실제 Job 종료 확인이 없습니다');
          const current = await new BrowserFreshness(this.store, this.targetResolver()).capture(id, candidateId);
          if (current.version !== initialBasis.version) { final.status = 'stale'; final.error = '검증 중 실제 입력 또는 후보 기준이 변경되었습니다'; }
          else { final.freshnessEvidence = { version: 1, runId: row.id, environmentId: row.environmentId, rawSourceRevision: row.environment.sourceRevision, executedCommit: row.environment.commit, buildId: result!.buildAttestation!.buildId, basis: initialBasis.basis, semanticVersion: initialBasis.version }; if (!browserEvidenceValid(final)) throw new Error('실제 빌드·환경 근거의 연결을 확인할 수 없습니다'); }
        }
        if (!active.cancelled && !this.executionBindings().isCurrent(executionBinding)) { final.status = 'stale'; final.error = '검증 대상 또는 대화 실행 컨텍스트가 변경됐습니다'; delete final.freshnessEvidence; }
        if (active.cancelled) { final.status = 'interrupted'; final.error = '검증이 중단됐습니다. 입력을 자동 반복하지 않습니다'; delete final.freshnessEvidence; }
        Object.assign(row, final);
        finishBrowserLease(this.store, lease, row, true, () => {
          if (owner === 'user') { const latest = this.work(id); if (latest.state === 'running' && latest.threadId === row.threadId && (latest.turnId ?? null) === row.turnId && this.context(latest).executionContext === row.executionContext) { latest.state = active.cancelled ? 'interrupted' : 'idle'; this.store.save(latest); } }
        });
        try { this.store.event(id, 'browser-finished', { id: row.id, status: row.status }); } catch { /* The primary receipt and slot already committed. */ }
      } catch (error: any) {
        Object.assign(row, { status: 'blocked', cleanupStatus: 'uncertain', snapshotStatus: snapshot ? removed ? 'removed' : 'retained' : 'unavailable', processTerminated: !!lease.proof, error: error.message }); delete row.freshnessEvidence;
        lease.phase = 'uncertain';
        try { finishBrowserLease(this.store, lease, row, false); } catch { /* The exact durable running/uncertain slot remains held. */ }
      } finally { if (this.active === active) this.active = undefined; resolveDone(); }
    })();
    const stop = async () => {
      active.abort.abort(); if (active.child?.connected) active.child.send({ cancel: true }, () => {});
      if (handle?.requestStop) handle.requestStop(); else if (active.child && row.dispatched !== true && !closed) active.child.kill();
      await finish();
    };
    active.stop = stop;
    const timer = setTimeout(() => { active.cancelled = true; void stop(); }, 130000);
    try { this.store.event(id, 'browser-started', { id: row.id }); } catch { /* Slot reservation is already durable. */ }
    void (async () => {
      try {
        this.executionBindings().assertRun(executionBinding);
        environmentProof = await this.targetEnvironments().capture({ sourceId: work.sourceId, workId: id, ...(candidateId ? { candidateId } : {}) });
        const environment = environmentProof.environment;
        initialBasis = await new BrowserFreshness(this.store, this.targetResolver()).capture(id, candidateId);
        if (environment.executionPath !== root) throw new ConflictException('검증 대상 경로가 변경됐습니다');
        snapshot = await this.snapshots.prepare(this.work(id), root, active.abort.signal, environment); await environmentProof.assertCurrent();
        if (finalization) throw new ConflictException('종료 확인이 시작된 준비를 다시 실행하지 않습니다');
        Object.assign(row, { environmentId: environment.environmentId, environment, targetVersion: environment.targetVersion, build: environment.build, snapshot }); row.snapshotRoot = snapshot.root; row.revision = snapshot.revision; row.snapshotStatus = 'ready';
        const plan = { kind: 'workspace' as const, root: snapshot.root, commonDir: snapshot.root, spaces: [environment.dataPath, environment.evidencePath], refs: [] };
        lease.releaseScope = projectCoordinator(this.store).acquireOperation(plan);
        checkpointBrowser(this.store, lease, row, { snapshot, intent: { scope: 'workspace', root: snapshot.root, commonDir: snapshot.root, affectedRoots: plan.spaces, refs: [], stage: 'browser-snapshot', status: 'running' } });
        active.abort.signal.throwIfAborted();
        if (Object.keys(this.context(this.work(id))).some(key => (this.context(this.work(id)) as any)[key] !== row[key])) throw new ConflictException('사본 준비 중 검증 실행 컨텍스트가 변경됐습니다');
        this.executionBindings().assertRun(executionBinding);
        const source = existsSync(join(__dirname, 'browser-worker.js')) ? join(__dirname, 'browser-worker.js') : join(__dirname, 'browser-worker.ts');
        const env: NodeJS.ProcessEnv = { OPENSPEC_BROWSER_DIRECTORY: browserDirectory(), OPENSPEC_VERIFICATION_DATA_ROOT: resolve(process.env.DATA_DIR || '../.data') };
        for (const key of ['SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT', 'PATH', 'Path']) if (process.env[key]) env[key] = process.env[key];
        const runtime = localRuntimeDirectory(); if (runtime) env.OPENSPEC_NODE_DIRECTORY = runtime;
        resolvePreparation();
        const child = active.child = fork(source, [], { execPath: process.execPath, execArgv: source.endsWith('.ts') ? ['--import', pathToFileURL(require.resolve('tsx')).href] : [], env, silent: true, windowsHide: true });
        row.workerSpawned = true; row.processId = child.pid ?? null;
        child.once('close', () => { closed = true; row.workerClosed = true; lease.proof = observeTermination(); resolveClosed(); void finish(); });
        child.once('error', () => { void stop(); });
        checkpointBrowser(this.store, lease, row);
        row.terminationWitness = prepareBrowserWitness(this.store); checkpointBrowser(this.store, lease, row);
        guard = guardBrowserProcess(child, undefined, { browserProtocol: true, witness: row.terminationWitness }); void guard.catch(() => {});
        child.on('message', (message: any) => {
          if (closed || finalization) return;
          if (message?.step) try { row.steps.push(message.step); checkpointBrowser(this.store, lease, row); this.store.event(id, 'browser-step', message.step); } catch { void stop(); }
          if (message?.result) result = message.result;
        });
        child.stdout?.resume(); child.stderr?.resume();
        handle = await guard; if (closed || finalization) throw new ConflictException('메시지 전달 전에 검증 실행기가 종료됐습니다'); row.guardPid = handle.pid ?? null; row.terminationWitness = bindBrowserWitness(this.store, row.terminationWitness, row.processId, row.guardPid); checkpointBrowser(this.store, lease, row);
        active.abort.signal.throwIfAborted();
        this.executionBindings().assertRun(executionBinding);
        row.dispatched = true; checkpointBrowser(this.store, lease, row);
        child.send({ scenario, root: snapshot.root, snapshot, environment }, error => { if (error) void stop(); });
      } catch (error) {
        resolvePreparation(); if (snapshot) lease.snapshot = snapshot;
        row.error = error instanceof Error ? error.message : '검증 사본 준비에 실패했습니다';
        result = { status: active.cancelled ? 'interrupted' : 'blocked', error: row.error, steps: [], viewport: { width: 1280, height: 800 }, consoleErrors: 0 };
        if (finalization) { if (!active.child) lease.proof = proofForBrowser(lease, row, { state: 'not-started' }); return; }
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
    if (active.stop) await active.stop(); else await active.done; return { requested: true };
  }
  /** Host recovery only: no PID probes, kills, new browser execution or input replay. */
  async reconcile(id: string, runId: string, confirmed: boolean) {
    if (confirmed !== true || typeof runId !== 'string') throw new BadRequestException('정확한 실행 ID와 명시 확인이 필요합니다');
    const row = this.receipt(id, runId); if (!row) throw new NotFoundException('브라우저 실행 영수증이 없습니다');
    const lease = recoverBrowserLease(this.store, row), intent = browserRecord(this.store, row.intentId);
    const proof = lease.proof ?? (browserTerminationValid(row, browserSlot(this.store), intent) ? row.terminationProof : recoverBrowserWitness(this.store, row, browserSlot(this.store), intent));
    if (!proof) throw new ConflictException('소유 Job과 child의 실제 종료 근거가 없어 복구하지 않습니다');
    const slot = browserSlot(this.store);
    for (const receipt of [row, slot, intent].filter(Boolean)) if (receipt.processId != null && receipt.processId !== proof.workerPid || receipt.guardPid != null && receipt.guardPid !== proof.guardPid) throw new ConflictException('저장된 프로세스 소유 tuple이 종료 근거와 다릅니다');
    lease.reconciling = true;
    try {
      const snapshot = lease.snapshot ?? browserSlot(this.store).snapshot;
      Object.assign(row, { terminationProof: proof, processTerminated: true, workerClosed: proof.state !== 'not-started', processId: proof.workerPid, guardPid: proof.guardPid, ...(snapshot ? { snapshot } : {}) });
      checkpointBrowser(this.store, lease, row, { ...(snapshot ? { snapshot } : {}) });
      const permit = () => { assertBrowserLease(this.store, lease, row); if (!browserTerminationValid(browserRecord(this.store, row.id), browserSlot(this.store), browserRecord(this.store, row.intentId))) throw new ConflictException('현재 종료 근거가 변경되었습니다'); };
      permit();
      if (snapshot && await this.snapshots.restore(snapshot)) await this.snapshots.cleanup(snapshot, permit);
      Object.assign(row, { status: 'interrupted', snapshotStatus: snapshot ? 'removed' : 'unavailable', cleanupStatus: 'confirmed', reconciliation: 'terminated', error: '실제 종료를 재확인했습니다. 이전 입력·검증을 자동 반복하지 않았습니다' }); delete row.freshnessEvidence;
      finishBrowserLease(this.store, lease, row, true, () => { if (row.owner === 'user') { const work = this.work(id); if (work.state === 'running' && work.threadId === row.threadId && (work.turnId ?? null) === (row.turnId ?? null) && this.context(work).executionContext === row.executionContext) { work.state = 'interrupted'; this.store.save(work); } } }); const { terminationWitness: _witness, ...receipt } = row; return receipt;
    } finally { lease.reconciling = false; }
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
