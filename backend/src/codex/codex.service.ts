import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { Work, WorkStore } from '../work/store';
import { LegacyService } from '../legacy/legacy.service';
import { CodexClient, CodexRpcRejectedError } from './client';
import { randomUUID } from 'node:crypto';
import { Subscription } from 'rxjs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { markdownFiles } from '../legacy/parser';
import { textFile, within } from '../files';
import { askUserTool, unresolvedQuestion } from './questions';
import { reviewInstructions } from '../review/instructions';
import { testingInstructions } from '../work/testing-instructions';
import { findRollout } from './rollout';
import { FileResults } from '../work/file-results';
import { WorkRecovery } from '../work/recovery';
import { projectCoordinator } from '../projects/coordinator';
import { EdgeService } from '../browser/edge.service';
import { edgeBrowserTool, edgeToolResponse } from '../browser/edge-tools';
import { BrowserService } from '../browser/browser.service';
import { backgroundBrowserTool, backgroundToolResponse } from '../browser/browser-tools';
import { localRuntimeDirectory } from '../runtime';
import { desktopHealth } from '../desktop/health';
import { addNativeRecoveryHistory, recoveryContext } from './recovery-context';
const browserTools = [askUserTool, edgeBrowserTool, backgroundBrowserTool];
const childItems = (turns: any[]): any[] => turns.flatMap(turn => Array.isArray(turn.items) ? turn.items.filter((item: any) => ['collabAgentToolCall', 'subAgentActivity'].includes(item.type)) : []);
function hasUnconfirmedChildren(turns: any[]) {
  const states = new Map<string, string>(); let unidentified = false;
  for (const item of childItems(turns)) {
    if (item.type === 'subAgentActivity') {
      if (typeof item.agentThreadId !== 'string' || !item.agentThreadId) { unidentified = true; continue; }
      states.set(item.agentThreadId, ['completed', 'interrupted'].includes(item.kind) ? item.kind : 'unknown'); continue;
    }
    const observed = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {};
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((id: unknown) => typeof id === 'string' && id) : [];
    const ids = [...new Set([...receivers, ...Object.keys(observed)])];
    const startsWork = !['wait', 'listAgents', 'closeAgent', 'interruptAgent'].includes(item.tool);
    if (startsWork && !ids.length) unidentified = true;
    for (const id of ids) {
      const status = observed[id]?.status;
      if (startsWork) states.set(id, 'unknown');
      // Later wait/close/interrupt observations supersede earlier spawn state.
      if (typeof status === 'string') states.set(id, status);
      else if (!states.has(id)) states.set(id, 'unknown');
    }
  }
  return unidentified || [...states.values()].some(status => !['completed', 'interrupted', 'errored', 'shutdown'].includes(status));
}

@Injectable()
export class CodexService implements OnModuleDestroy {
  client = new CodexClient();
  private clients = new Map<string, CodexClient>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private loaded = new Set<string>();
  private locks = new Set<string>();
  private draining = new Set<string>();
  private queueSubscription: Subscription;
  private closing = false;
  private active = new Map<string, { token: symbol; generation: string; turnId?: string; priorTurnId?: string; notifications?: any[]; childItems?: any[]; state: 'active' | 'unknown' }>();
  private stopped = new Set<string>();
  constructor(@Inject(WorkStore) readonly store: WorkStore, @Inject(LegacyService) readonly legacy: LegacyService, @Inject(EdgeService) readonly edge: EdgeService, @Inject(BrowserService) readonly browser: BrowserService) {
    desktopHealth(store).registerInterrupt('codex', work => {
      const run = this.active.get(work.id);
      return !!run && run.generation === this.clientFor(work.id).generation && !!work.threadId && !!run.turnId && !this.locks.has(work.id);
    });
    desktopHealth(store).register('codex', work => {
      if (work.toolId && work.toolId !== 'codex') return undefined;
      if (this.locks.has(work.id)) return 'active';
      const run = this.active.get(work.id); if (run) return run.state;
      if (this.stopped.has(work.id) || work.executionUnconfirmed === false) return 'inactive';
      if (['completed', 'archived'].includes(work.phase)) return 'inactive';
      return ['running', 'connecting', 'creating-thread', 'waiting-input', 'waiting-approval', 'recovery-required'].includes(work.state) ? 'unknown' : 'inactive';
    });
    this.queueSubscription = store.updates.subscribe(event => setImmediate(() => { void this.drain(event.workId); }));
    for (const work of this.store.list().filter(work => (!work.toolId || work.toolId === 'codex') && !['completed', 'archived'].includes(work.phase))) {
      const sessionRecovery = work.sessionRecovery as any;
      if (sessionRecovery?.status === 'creating') {
        sessionRecovery.status = 'uncertain'; work.sessionRecovery = sessionRecovery;
        for (const record of store.records(work.id, 'session-recovery').filter(record => record.requestId === sessionRecovery.requestId)) store.record(record.id, work.id, 'session-recovery', { ...record, status: 'uncertain' });
        store.save(work);
      }
      if (['running', 'connecting', 'creating-thread', 'waiting-input', 'waiting-approval'].includes(work.state)) {
        work.state = 'recovery-required'; work.error = '세션 서버가 재시작되었습니다. 같은 대화로 복구할 수 있습니다.'; work.errorCode = 'session-restarted'; this.store.save(work);
      }
      for (const q of this.store.records(work.id, 'question').filter(x => ['pending', 'sending', 'recovering', 'uncertain'].includes(x.status))) this.store.record(q.id, work.id, 'question', { ...q, status: 'expired' });
      for (const queued of this.store.records(work.id, 'queued-message').filter(x => x.status === 'dispatching')) this.store.record(queued.id, work.id, 'queued-message', { ...queued, status: 'uncertain' });
    }
    this.bindClient(this.client);
  }
  private clientFor(id: string) {
    let client = this.clients.get(id);
    if (!client) { client = this.clients.size ? new CodexClient() : this.client; this.clients.set(id, client); if (client !== this.client) this.bindClient(client); }
    return client;
  }
  private canDisposeClient(id: string) {
    const work = this.store.get(id);
    return !!work && work.executionUnconfirmed === false && !this.locks.has(id) && !this.active.has(id) && !this.draining.has(id) && desktopHealth(this.store).runtime(work) === 'inactive'
      && !this.store.records(id, 'question').some(question => ['pending', 'sending', 'recovering', 'uncertain'].includes(question.status))
      && !this.store.records(id, 'queued-message').some(message => ['pending', 'queued', 'dispatching', 'uncertain'].includes(message.status));
  }
  private scheduleIdleDisposal(id: string) {
    if (this.idleTimers.has(id)) clearTimeout(this.idleTimers.get(id));
    this.idleTimers.delete(id);
    if (this.closing || !this.clients.has(id) || !this.canDisposeClient(id)) return;
    const client = this.clients.get(id)!;
    const timer = setTimeout(() => {
      this.idleTimers.delete(id);
      if (this.closing || this.clients.get(id) !== client || !this.canDisposeClient(id)) return;
      const work = this.store.get(id)!;
      if (work.threadId) this.loaded.delete(work.threadId);
      this.clients.delete(id); client.removeAllListeners();
      if (client === this.client) { this.client = new CodexClient(); this.bindClient(this.client); }
      void client.close().catch(() => { /* No active execution was owned; reconnect explicitly on next use. */ });
    }, 120000);
    timer.unref(); this.idleTimers.set(id, timer);
  }
  private bindClient(client: CodexClient) {
    client.on('notification', message => {
      try { this.notification(message, client); }
      catch (error: any) {
        const work = this.store.list().find(w => w.threadId === message.params?.threadId && this.clients.get(w.id) === client);
        if (!work) return;
        if (message.method === 'turn/completed') work.state = message.params.turn?.status === 'completed' ? 'idle' : message.params.turn?.status === 'interrupted' ? 'interrupted' : 'failed';
        work.error = `실행 알림의 문서 상태를 갱신하지 못했습니다. 대화 기록을 보존했습니다: ${error.message}`;
        this.store.save(work); this.store.event(work.id, 'codex-processing-error', { method: message.method, params: message.params, message: error.message }); this.legacy.updates.next(); this.scheduleIdleDisposal(work.id);
      }
    });
    client.on('disconnected', message => {
      for (const [id, connection] of this.clients) if (connection === client) { const work = this.store.get(id); if (work?.threadId) this.loaded.delete(work.threadId); }
      for (const work of this.store.list().filter(w => this.clients.get(w.id) === client && (this.active.has(w.id) || this.locks.has(w.id)))) {
        const run = this.active.get(work.id);
        if (run) { run.state = 'unknown'; run.generation = `disconnected:${run.generation}`; }
        this.stopped.delete(work.id);
        if (['completed', 'archived'].includes(work.phase)) continue;
        this.edge.bridge.disconnect(work.id);
        void this.browser.cancel(work.id);
        work.state = 'recovery-required'; work.error = message; work.errorCode = 'codex-disconnected'; this.store.save(work);
        desktopHealth(this.store).event('codex-disconnected', work.id, 'recovery-required');
        for (const q of this.store.records(work.id, 'question').filter(x => x.status === 'pending')) this.store.record(q.id, work.id, 'question', { ...q, status: 'expired' });
      }
      this.legacy.updates.next();
    });
  }
  async status() {
    await this.client.ready(); const result = await this.client.rpc('account/read', { refreshToken: false });
    return { connected: true, authenticated: !!result.account, accountType: result.account?.type ?? null };
  }
  async send(id: string, text: string, phase?: string) {
    const client = this.clientFor(id);
    desktopHealth(this.store).assertExecutionAllowed();
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new BadRequestException('메시지를 입력해 주세요');
    const work = this.store.get(id);
    if (!work) throw new BadRequestException('업무가 없습니다');
    if (['creating', 'uncertain'].includes((work.sessionRecovery as any)?.status)) throw new ConflictException('복구 세션 생성 결과를 먼저 확인해 주세요. 지시를 재전송하지 않습니다.');
    if (['implementation', 'verification'].includes(phase || work.phase)) this.requireReviewedPlan(work);
    if (['archived', 'completed'].includes(work.phase)) throw new ConflictException('완료된 업무는 수정 단계로 다시 열어 주세요');
    if (desktopHealth(this.store).runtime(work) === 'unknown') throw new ConflictException('이전 실행 결과가 불명확합니다. 같은 대화 재연결로 확인한 뒤 직접 요청해 주세요.');
    if (this.locks.has(id) || ['running', 'waiting-input', 'waiting-approval', 'connecting', 'creating-thread'].includes(work.state)) {
      const queuedId = randomUUID(); this.store.record(queuedId, id, 'queued-message', { text, phase, status: 'queued' });
      this.store.event(id, 'message-queued', { id: queuedId, text }); return { ...work, queued: true };
    }
    if (work.state === 'recovery-required' && !work.threadId) throw new ConflictException('대화 생성 결과가 불명확합니다. 새 대화를 자동 생성하지 않습니다');
    new WorkRecovery(this.store).assertWritableFolder(work, this.executionCwd(work, phase));
    projectCoordinator(this.store).assertWorkCanStart(work);
    const token = Symbol(id);
    this.stopped.delete(id); this.locks.add(id); work.executionUnconfirmed = false; work.state = 'connecting'; this.store.save(work);
    try {
      await client.ready();
      const generation = client.generation;
      if (!work.threadId) {
        work.state = 'creating-thread'; this.store.save(work);
        const result = await client.rpc('thread/start', { cwd: this.executionCwd(work, phase), ephemeral: false, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', dynamicTools: browserTools,
          developerInstructions: '사용자와 한국어로 문답하며 같은 업무를 계속 진행한다. 불명확한 요구사항은 ask_user 도구로 질문하고 답변을 관련 문서에 반영한다. 계획 단계에서는 지정된 OpenSpec 변경 문서만 작성·수정하고 제품 코드를 구현하지 않는다. 구현은 사용자의 구현 시작 지시 후에 진행한다. 문서 작성·구현·검증 결과 생성만으로 사용자 검토나 완료를 대체하지 않는다.' });
        work.threadId = result.thread.id; work.providerSessionId = work.threadId; work.edgeToolsVersion = 1; if (result.thread.path) work.rolloutPath = result.thread.path; this.store.save(work); this.loaded.add(work.threadId!);
      } else if (!this.loaded.has(work.threadId)) {
        await this.resume(work);
        this.loaded.add(work.threadId);
      }
      if (generation !== client.generation) throw new Error('Codex 연결 세대가 변경되어 실행 결과 확인이 필요합니다');
      if (phase) work.phase = phase;
      if (['implementation', 'verification'].includes(work.phase)) this.requireReviewedPlan(this.store.get(id)!);
      work.documentVersions = this.documentVersions(work);
      work.executionUnconfirmed = true; this.active.set(id, { token, generation, priorTurnId: work.turnId, state: 'active' }); work.state = 'running'; delete work.error; delete work.errorCode; this.store.save(work);
      this.store.event(id, 'user-message', { text, threadId: work.threadId });
      const cwd = this.executionCwd(work);
      const changeRoot = join(work.executionPath ? new FileResults(this.store).path(work) : work.projectPath, 'openspec', 'changes', work.changeName);
      const writableRoots = work.executionPath && cwd !== work.executionPath ? [cwd, work.executionPath] : [cwd];
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const appRuntime = localRuntimeDirectory();
      const runtime = existsSync(join(cwd, '.tools/node-runtime/node.exe')) ? join(cwd, '.tools/node-runtime/node.exe') : appRuntime ? join(appRuntime, 'node.exe') : process.execPath;
      const browserInstruction = work.browserScenario ? `\n등록한 브라우저 시나리오가 있다. 새 도구가 없는 기존 대화의 PowerShell 실행 명령: ${existsSync(join(cwd, 'scripts/node.ps1')) ? './scripts/node.ps1 .tools/browser-verification/cli.cjs' : `& ${quote(runtime)} ${quote(join(cwd, '.tools/browser-verification/cli.cjs'))}`} run (또는 status, cancel). 등록 시나리오만 실행하며 결과의 imagePath로 화면을 확인한다.\n` : '';
      const result = await client.rpc('turn/start', { threadId: work.threadId, cwd, sandboxPolicy: { type: 'workspaceWrite', writableRoots, networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', input: [{ type: 'text', text: `현재 업무: ${work.changeName}\n현재 단계: ${work.phase}\n작업 경로: ${cwd}\nOpenSpec 변경: ${changeRoot}\n\n${reviewInstructions}\n\n${testingInstructions}\n${browserInstruction}\n${text}`, text_elements: [] }] });
      if (generation !== client.generation) throw new Error('Codex 연결 세대가 변경되어 실행 결과 확인이 필요합니다');
      const run = this.active.get(id);
      if (run?.token === token) { run.turnId = result.turn.id; for (const notification of run.notifications?.splice(0) || []) client.emit('notification', notification); }
      const latest = this.store.get(id)!; latest.turnId = result.turn.id; this.store.save(latest); this.legacy.updates.next(); return latest;
    } catch (error: any) {
      const run = this.active.get(id);
      if (run?.token === token) {
        if (error instanceof CodexRpcRejectedError && error.method === 'turn/start') { this.active.delete(id); this.stopped.add(id); const latest = this.store.get(id)!; latest.executionUnconfirmed = false; this.store.save(latest); }
        else run.state = 'unknown';
      } else if (!run && error instanceof CodexRpcRejectedError) this.stopped.add(id);
      throw this.connectionFailure(id, error);
    } finally { this.locks.delete(id); this.scheduleIdleDisposal(id); }
  }
  private executionCwd(work: Work, phase = work.phase) {
    const recovery = new WorkRecovery(this.store);
    if (recovery.isRecoveredThread(work)) return recovery.path(work);
    return ['implementation', 'verification'].includes(phase) ? new FileResults(this.store).path(work) : work.projectPath;
  }
  private async resume(work: Work) {
    const client = this.clientFor(work.id);
    // Legacy shared-folder work has no isolated workspace. Restoring its thread
    // does not start a turn; implementation still requires a validated workspace.
    const cwd = new WorkRecovery(this.store).path(work);
    // Installed Codex restores persisted tools but cannot add dynamicTools on
    // resume. Existing conversations use the work-local mailbox CLI instead.
    const params = { threadId: work.threadId, cwd, excludeTurns: true, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' };
    let result;
    try { result = await client.rpc('thread/resume', params); }
    catch (error: any) {
      if (!/no rollout found for thread id/.test(error.message)) throw error;
      const path = await findRollout(work.threadId!, cwd) || (cwd !== work.projectPath ? await findRollout(work.threadId!, work.projectPath) : undefined);
      if (!path) throw error;
      result = await client.rpc('thread/resume', { ...params, path });
      if (result.thread.id !== work.threadId) throw new Error('대화 원본의 ID가 일치하지 않습니다. 기존 업무 연결을 보존했습니다.');
      work.rolloutPath = path;
    }
    if (result.thread.id !== work.threadId) throw new Error('재연결 대화 ID가 달라 기존 연결을 보존했습니다');
    if (result.thread.path) work.rolloutPath = result.thread.path;
    this.store.save(work);
    return result;
  }
  private connectionFailure(id: string, error: Error) {
    const latest = this.store.get(id)!;
    const conflict = /already has an active writer/.test(error.message);
    latest.state = 'recovery-required';
    latest.error = conflict ? '다른 Codex 앱에서 이 업무 대화를 사용 중입니다. 해당 앱에서 이 대화를 닫은 뒤 ‘같은 대화 다시 연결’을 눌러 주세요. 문서와 대화 기록은 유지됩니다.' : error.message;
    if (conflict) { latest.errorCode = 'thread-in-use'; if (latest.threadId) this.loaded.delete(latest.threadId); }
    else latest.errorCode = 'connection-failed';
    latest.error = String(latest.error).slice(0, 2000);
    if (conflict && error instanceof CodexRpcRejectedError) {
      // Only instructions that have never been dispatched can be safely held.
      // Preserve dispatching/uncertain records as execution evidence.
      this.store.transaction(() => {
        for (const queued of this.store.records(id, 'queued-message').filter(record => ['pending', 'queued'].includes(record.status))) this.store.record(queued.id, id, 'queued-message', { ...queued, status: 'blocked', error: '외부 Codex 점유로 보내지 않았습니다. 내용을 확인하고 직접 다시 보내 주세요.' });
      });
    }
    desktopHealth(this.store).event('execution-failed', id, 'recovery-required', String(latest.errorCode));
    this.store.save(latest); this.legacy.updates.next();
    return new ConflictException({ message: latest.error, errorCode: latest.errorCode });
  }
  async reconnect(id: string) {
    const client = this.clientFor(id);
    const work = this.store.get(id);
    if (!work) throw new NotFoundException('업무를 찾을 수 없습니다');
    const recovery = new WorkRecovery(this.store).assertReconnect(work);
    projectCoordinator(this.store).assertWorkCanStart(work);
    if (this.locks.has(id) || !['recovery-required', 'idle', 'interrupted', 'failed'].includes(work.state)) throw new ConflictException('실행을 마친 뒤 다시 연결해 주세요.');
    const uncertain = desktopHealth(this.store).runtime(work) === 'unknown';
    const previousRun = this.active.get(id);
    this.stopped.delete(id); this.locks.add(id); work.executionUnconfirmed = uncertain; work.state = 'connecting'; this.store.save(work);
    try {
      await client.ready();
      const generation = client.generation;
      await this.resume(work);
      if (generation !== client.generation) throw new Error('Codex 연결 세대가 변경되어 복구 결과 확인이 필요합니다');
      // A resumed writer is not proof that an old turn or its children finished.
      // Only terminal evidence for the same known turn can clear uncertainty.
      const expectedTurnId = previousRun ? previousRun.turnId : work.turnId;
      let turns: any[] = [];
      if (uncertain) {
        try { const observed = await client.rpc('thread/read', { threadId: work.threadId, includeTurns: true }); if (observed.thread?.id === work.threadId && Array.isArray(observed.thread.turns)) turns = observed.thread.turns; }
        catch { /* Read failure preserves unknown; reconnect itself remains useful. */ }
      }
      if (generation !== client.generation) throw new Error('Codex 연결 세대가 변경되어 실행 확인이 필요합니다');
      const observedActiveTurn = turns.find(turn => typeof turn.id === 'string' && turn.status === 'inProgress' && turn.id !== previousRun?.priorTurnId)?.id;
      const observedChildItems = turns.length ? childItems(turns) : previousRun?.childItems || [];
      const unconfirmedChildren = hasUnconfirmedChildren([{ items: observedChildItems }]);
      const completed = expectedTurnId && !unconfirmedChildren && !turns.some(turn => !['completed', 'interrupted', 'failed'].includes(turn.status)) && turns.some(turn => turn.id === expectedTurnId && ['completed', 'interrupted', 'failed'].includes(turn.status));
      const interruptTurnId = observedActiveTurn || expectedTurnId;
      const remainsUnknown = uncertain && !completed;
      if (remainsUnknown) {
        this.active.set(id, { token: previousRun?.token || Symbol(id), generation, turnId: interruptTurnId, priorTurnId: previousRun?.priorTurnId, childItems: observedChildItems, state: 'unknown' });
        this.stopped.delete(id);
      } else { this.active.delete(id); this.stopped.add(id); }
      this.loaded.add(work.threadId!);
      const latest = this.store.get(id)!;
      if (remainsUnknown && interruptTurnId) latest.turnId = interruptTurnId;
      latest.executionUnconfirmed = remainsUnknown; latest.state = remainsUnknown ? 'recovery-required' : 'idle';
      if (remainsUnknown) { latest.error = '대화 연결은 복원했지만 이전 실행의 종료를 확인하지 못했습니다. 실행 중단 또는 완료 확인이 필요합니다.'; latest.errorCode = 'execution-unconfirmed'; }
      else { delete latest.error; delete latest.errorCode; }
      this.store.transaction(() => {
        // A reconnect must not dispatch instructions left over from a lost turn.
        for (const queued of this.store.records(id, 'queued-message').filter(message => message.status === 'queued')) {
          this.store.record(queued.id, id, 'queued-message', { ...queued, status: 'blocked', error: '업무 복구 후 문서와 실행 기록을 확인하고 필요한 내용만 다시 보내주세요.' });
        }
        this.store.save(latest);
      });
      this.store.event(id, 'thread-reconnected', { threadId: work.threadId, mode: recovery.mode, code: recovery.code }); this.legacy.updates.next(); return latest;
    } catch (error: any) {
      const failure = this.connectionFailure(id, error);
      this.store.event(id, 'recovery-failed', { threadId: work.threadId, code: this.store.get(id)!.errorCode, mode: recovery.mode });
      throw failure;
    }
    finally { this.locks.delete(id); this.scheduleIdleDisposal(id); }
  }
  async recoverSession(id: string, body: any) {
    if (typeof body?.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.requestId)) throw new BadRequestException('유효한 복구 요청 ID가 필요합니다');
    const work = this.store.get(id); if (!work) throw new NotFoundException('업무를 찾을 수 없습니다');
    const previous = this.store.records(id, 'session-recovery');
    const existing = previous.find(record => record.requestId === body.requestId);
    if (existing && existing.status !== 'blocked' && existing.status !== 'prepared') return { ...work, sessionRecovery: { ...existing, status: existing.status === 'creating' ? 'uncertain' : existing.status } };
    if (previous.some(record => ['creating', 'uncertain'].includes(record.status))) throw new ConflictException('이전 복구 세션 생성 결과 확인이 필요합니다. 새 세션을 중복 생성하지 않습니다.');
    if (this.locks.has(id) || ['completed', 'archived'].includes(work.phase)) throw new ConflictException('연결 작업을 마친 뒤 복구해 주세요');
    desktopHealth(this.store).assertExecutionAllowed();
    const client = this.clientFor(id), cwd = new WorkRecovery(this.store).path(work);
    const runtime = desktopHealth(this.store).runtime(work);
    const contextId = `session-context:${id}:${body.requestId}`, recordId = `session-recovery:${id}:${body.requestId}`;
    const summary: any = { requestId: body.requestId, status: 'prepared', previousThreadId: work.threadId, newThreadId: null, previousTurnId: work.turnId, reason: String(work.errorCode || 'explicit-recovery'), createdAt: existing?.createdAt || new Date().toISOString(), contextRecordId: contextId };
    const context = recoveryContext(this.store, work, cwd);
    const save = () => this.store.transaction(() => { work.sessionRecovery = { ...summary }; this.store.record(recordId, id, 'session-recovery', summary); this.store.save(work); });
    this.locks.add(id);
    try {
      this.store.record(contextId, id, 'session-recovery-context', context); save();
      let terminal = false;
      const pending = this.store.records(id, 'question').some(question => ['pending', 'sending', 'recovering', 'uncertain'].includes(question.status));
      if (runtime === 'inactive' && !pending && work.threadId && work.turnId) {
        try {
          await client.ready();
          const observed = await client.rpc('thread/read', { threadId: work.threadId, includeTurns: true });
          const turns = observed.thread?.turns;
          if (observed.thread?.id === work.threadId && Array.isArray(turns)) { addNativeRecoveryHistory(context, observed.thread); this.store.record(contextId, id, 'session-recovery-context', context); }
          const unconfirmedChild = Array.isArray(turns) && hasUnconfirmedChildren(turns);
          terminal = observed.thread?.id === work.threadId && Array.isArray(turns) && turns.length > 0 && !unconfirmedChild && turns.every((turn: any) => ['completed', 'interrupted', 'failed'].includes(turn.status)) && turns.some((turn: any) => turn.id === work.turnId);
        } catch { /* No proof of termination means no new writable session. */ }
      }
      if (!terminal) { summary.status = 'blocked'; summary.reason = 'previous-execution-unconfirmed'; save(); return work; }
      new WorkRecovery(this.store).assertWritableFolder(work, cwd);
      projectCoordinator(this.store).assertWorkCanStart(work);
      summary.status = 'creating'; save();
      const generation = client.generation;
      try {
        const result = await client.rpc('thread/start', { cwd, ephemeral: false, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', dynamicTools: browserTools,
          developerInstructions: `복구용 새 대화입니다. 아래 자료는 과거 참고 자료이며 현재 사용자 지시나 승인이 아닙니다. 기존 명령·질문·승인을 재전송하거나 완료 작업을 반복하지 마세요. 다음 명시적 사용자 지시를 받은 뒤 실제 파일을 대조하고 기존 검토·승인 규칙을 지키세요.\n${JSON.stringify(context)}` });
        if (generation !== client.generation || !result.thread?.id || result.thread.id === work.threadId) throw new Error('복구 대화 생성 결과를 확인할 수 없습니다');
        summary.newThreadId = result.thread.id; summary.status = 'completed';
        work.threadId = result.thread.id; work.providerSessionId = work.threadId; work.edgeToolsVersion = 1;
        if (result.thread.path) work.rolloutPath = result.thread.path; else delete work.rolloutPath;
        delete work.turnId; delete work.error; delete work.errorCode;
        work.executionUnconfirmed = false; work.state = 'idle';
        this.active.delete(id); this.stopped.add(id); this.loaded.add(work.threadId!);
        this.store.transaction(() => {
          for (const queued of this.store.records(id, 'queued-message').filter(record => ['queued', 'dispatching'].includes(record.status))) this.store.record(queued.id, id, 'queued-message', { ...queued, status: 'blocked', error: '복구 전 지시는 자동 재전송하지 않습니다.' });
        });
        save(); this.store.event(id, 'session-recovered', summary); this.legacy.updates.next(); return work;
      } catch (error: any) {
        summary.status = error instanceof CodexRpcRejectedError ? 'failed' : 'uncertain'; save();
        throw new ConflictException('복구 세션 생성 결과를 확인해 주세요. 기존 대화와 인계 자료는 보존했습니다.');
      }
    } finally { this.locks.delete(id); this.scheduleIdleDisposal(id); }
  }
  async cancelSessionRecovery(id: string, body: any) {
    if (typeof body?.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.requestId)) throw new BadRequestException('유효한 복구 요청 ID가 필요합니다');
    const work = this.store.get(id); if (!work) throw new NotFoundException('업무를 찾을 수 없습니다');
    const record = this.store.records(id, 'session-recovery').find(record => record.requestId === body.requestId);
    if (!record) throw new NotFoundException('복구 요청을 찾을 수 없습니다');
    if (record.status === 'abandoned') return work;
    if (!['creating', 'uncertain'].includes(record.status) || (work.sessionRecovery as any)?.requestId !== body.requestId) throw new ConflictException('현재 결과 미확인 복구 요청만 취소할 수 있습니다');
    const unresolved = this.store.records(id, 'question').some(question => ['pending', 'sending', 'recovering', 'uncertain'].includes(question.status)) || this.store.records(id, 'queued-message').some(message => ['dispatching', 'uncertain'].includes(message.status));
    if (this.locks.has(id) || desktopHealth(this.store).runtime(work) !== 'inactive' || unresolved || !work.threadId || !work.turnId || work.threadId !== record.previousThreadId) throw new ConflictException('이전 실행·응답의 종료 상태를 확인한 뒤 복구를 취소해 주세요');
    this.locks.add(id);
    try {
      const old = this.clientFor(id);
      // A thread/start creates no turn. Close only this Board-owned connection
      // before abandoning its uncertain result; never detach an unknown run.
      old.removeAllListeners(); await old.close();
      const client = new CodexClient(); this.bindClient(client); this.clients.set(id, client);
      if (old === this.client) this.client = client;
      this.loaded.delete(work.threadId);
      let terminal = false;
      try {
        await client.ready();
        const result = await client.rpc('thread/read', { threadId: work.threadId, includeTurns: true });
        const turns = result.thread?.turns;
        terminal = result.thread?.id === work.threadId && Array.isArray(turns) && turns.length > 0 && !hasUnconfirmedChildren(turns) && turns.every((turn: any) => ['completed', 'interrupted', 'failed'].includes(turn.status)) && turns.some((turn: any) => turn.id === work.turnId);
      } catch { /* Keep the uncertain record until explicit terminal evidence. */ }
      if (!terminal) throw new ConflictException('원래 세션의 종료를 확인하지 못했습니다. 인계 자료와 미확인 복구 기록을 보존했습니다. 다시 확인해 주세요.');
      const summary = { ...record, status: 'abandoned', abandonedAt: new Date().toISOString(), reason: 'explicit-cancellation-after-terminal-check' };
      work.sessionRecovery = summary; work.executionUnconfirmed = false;
      this.store.transaction(() => {
        for (const queued of this.store.records(id, 'queued-message').filter(message => ['pending', 'queued'].includes(message.status))) this.store.record(queued.id, id, 'queued-message', { ...queued, status: 'blocked', error: '복구 취소 후 내용을 확인하고 직접 다시 보내 주세요.' });
        this.store.record(record.id, id, 'session-recovery', summary); this.store.save(work);
      });
      this.store.event(id, 'session-recovery-abandoned', { requestId: body.requestId, previousThreadId: work.threadId }); this.legacy.updates.next(); return work;
    } finally { this.locks.delete(id); this.scheduleIdleDisposal(id); }
  }
  private notification(message: any, client: CodexClient) {
    if (message.generation && message.generation !== client.generation) return;
    const params = message.params || {}, work = this.store.list().find(w => w.threadId === params.threadId && this.clients.get(w.id) === client);
    if (!work) {
      const previous = this.store.list().find(work => this.clients.get(work.id) === client && this.store.records(work.id, 'session-recovery').some(record => record.previousThreadId === params.threadId));
      if (previous) { this.store.event(previous.id, 'previous-session-notification', { threadId: params.threadId, method: message.method, params, referenceOnly: true }); this.legacy.updates.next(); }
      return;
    }
    const run = this.active.get(work.id);
    if (message.method === 'turn/completed' && ((run?.state === 'unknown' && !run.turnId) || (!run && work.state === 'recovery-required' && desktopHealth(this.store).runtime(work) === 'unknown'))) return;
    if (run && (run.generation !== (message.generation || client.generation) || (run.turnId && (params.turnId || params.turn?.id) && run.turnId !== (params.turnId || params.turn?.id)))) return;
    if (run && !run.turnId && run.state === 'active' && (params.turnId || params.turn?.id)) { (run.notifications ||= []).push(message); return; }
    if (run && !run.turnId && run.priorTurnId && (params.turnId || params.turn?.id) === run.priorTurnId) return;
    if (run && ['collabAgentToolCall', 'subAgentActivity'].includes(params.item?.type)) {
      const items = run.childItems ||= [], index = params.item.id ? items.findIndex(item => item.id === params.item.id) : -1;
      if (index >= 0) items.splice(index, 1);
      items.push(params.item);
    }
    if (run && hasUnconfirmedChildren([{ items: run.childItems || [] }]) && message.method === 'turn/completed') {
      run.state = 'unknown'; work.executionUnconfirmed = true; work.state = 'recovery-required';
      work.error = '부모 실행은 끝났지만 자식 작업의 종료를 확인하지 못했습니다. 새 변경 작업을 보류합니다.'; work.errorCode = 'child-execution-unconfirmed';
      this.store.save(work); this.store.event(work.id, message.method, params); this.legacy.updates.next(); return;
    }
    if (!run && ['completed', 'archived'].includes(work.phase)) return;
    if (message.id !== undefined) {
      const dynamic = message.method === 'item/tool/call';
      if (dynamic && params.tool === 'browser_verification') { void this.backgroundCall(work.id, message); return; }
      if (dynamic && params.tool === 'edge_browser') { void this.browserCall(work.id, message); return; }
      if (dynamic) {
        const questions = params.arguments?.questions;
        if (params.tool !== 'ask_user' || !Array.isArray(questions) || !questions.length || questions.some((q: any) => typeof q.id !== 'string' || typeof q.question !== 'string')) {
          client.respond(message.id, { success: false, contentItems: [{ type: 'inputText', text: '지원하지 않는 도구 또는 잘못된 질문입니다. ask_user 질문 형식으로 다시 요청해 주세요.' }] }); return;
        }
        params.questions = questions;
      }
      const kind = message.method === 'item/tool/requestUserInput' || dynamic ? 'input' : 'approval';
      this.store.record(`${client.generation}:${message.id}`, work.id, 'question', { requestId: message.id, generation: client.generation, kind, method: message.method, params, status: 'pending', createdAt: new Date().toISOString() });
      work.state = kind === 'input' ? 'waiting-input' : 'waiting-approval'; this.store.save(work);
    } else if (message.method === 'turn/completed') {
      this.active.delete(work.id); this.stopped.add(work.id); work.executionUnconfirmed = false;
      this.edge.bridge.cancel(work.id);
      void this.browser.cancel(work.id);
      for (const q of this.store.records(work.id, 'question').filter(q => q.status === 'pending' && q.params.turnId === params.turn?.id && q.generation === client.generation)) {
        this.store.record(q.id, work.id, 'question', { ...q, status: 'expired' }); client.requests.delete(q.requestId);
      }
      work.state = params.turn?.status === 'completed' ? 'idle' : params.turn?.status === 'interrupted' ? 'interrupted' : 'failed';
      if (params.turn?.error) work.error = params.turn.error.message;
      const before = work.documentVersions as Record<string, string> || {}, after = this.documentVersions(work);
      const changed = Object.keys(after).filter(path => before[path] !== after[path]);
      for (const q of this.store.records(work.id, 'question').filter(x => x.status === 'answered' && x.params.turnId === params.turn?.id && x.reflection === 'pending')) {
        this.store.record(q.id, work.id, 'question', { ...q, reflection: changed.length ? 'applied' : 'needs-review', documents: changed.map(path => ({ path, version: after[path] })) });
      }
      this.store.save(work);
    } else if (message.method === 'item/completed' && params.item?.type === 'dynamicToolCall' && params.item.success === false) {
      const q = this.store.records(work.id, 'question').find(q => q.status === 'pending' && q.params.callId === params.item.id && q.generation === client.generation);
      if (q) { this.store.record(q.id, work.id, 'question', { ...q, status: 'expired' }); client.requests.delete(q.requestId); }
    } else if (message.method === 'serverRequest/resolved') {
      const q = this.store.records(work.id, 'question').find(x => x.requestId === params.requestId && x.generation === client.generation && x.status === 'pending');
      if (q) this.store.record(q.id, work.id, 'question', { ...q, status: 'expired' });
    }
    this.store.event(work.id, message.method, params); this.legacy.updates.next(); this.scheduleIdleDisposal(work.id);
  }
  async answer(id: string, body: any) {
    const client = this.clientFor(id);
    const q = this.store.records(id, 'question').find(x => x.id === body?.questionId);
    const recovery = q?.status === 'expired' && body?.recover === true;
    if (q?.params?.threadId && q.params.threadId !== this.store.get(id)?.threadId) throw new ConflictException('이전 세션의 질문을 새 세션으로 복구할 수 없습니다');
    if (!q || (!recovery && (q.status !== 'pending' || q.generation !== client.generation))) throw new ConflictException('이미 답변했거나 만료된 질문입니다');
    if (q.kind !== 'input') throw new BadRequestException('실행 승인은 별도 동작으로 처리해야 합니다');
    if (!body.answers || typeof body.answers !== 'object') throw new BadRequestException('답변이 필요합니다');
    for (const question of q.params.questions) {
      const answer = body.answers[question.id];
      if (!answer || !Array.isArray(answer.answers) || !answer.answers.length || answer.answers.some((x: unknown) => typeof x !== 'string' || !x.trim())) throw new BadRequestException('모든 질문에 답변해 주세요');
    }
    if (recovery) {
      const work = this.store.get(id)!;
      if (!['idle', 'interrupted', 'failed', 'recovery-required'].includes(work.state)) throw new ConflictException('현재 실행을 마친 뒤 답변을 복구해 주세요');
      this.store.record(q.id, id, 'question', { ...q, status: 'recovering', answer: body.answers });
      try {
        const result = await this.send(id, `연결 종료로 만료된 확인 질문의 사용자 답변을 같은 대화에 복구한다. 질문: ${JSON.stringify(q.params.questions)}\n답변: ${JSON.stringify(body.answers)}\n결정을 관련 문서에 반영하고, 구현 전에 사용자 문서 검토를 다시 받는다. 제품 코드는 구현하지 않는다.`, 'planning');
        this.store.record(q.id, id, 'question', { ...q, params: { ...q.params, turnId: result.turnId }, status: 'answered', answer: body.answers, recovered: true, reflection: 'pending' });
        this.store.event(id, 'answer-recovered', { questionId: q.id, answers: body.answers }); return { ok: true, recovered: true };
      } catch (error) { this.store.record(q.id, id, 'question', { ...q, status: 'expired', answerDraft: body.answers }); throw error; }
    }
    this.store.record(q.id, id, 'question', { ...q, status: 'sending', answer: body.answers, reflection: 'pending' });
    try { client.respond(q.requestId, q.method === 'item/tool/call' ? { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ answers: body.answers }) }] } : { answers: body.answers }); }
    catch (error: any) { this.store.record(q.id, id, 'question', { ...q, status: 'uncertain', answer: body.answers }); throw new ConflictException(error.message); }
    this.store.record(q.id, id, 'question', { ...q, status: 'answered', answer: body.answers, reflection: 'pending' });
    const work = this.store.get(id)!; work.state = 'running'; this.store.save(work); this.store.event(id, 'answer', { questionId: q.id, answers: body.answers }); this.legacy.updates.next(); return { ok: true };
  }
  approval(id: string, body: any) {
    const client = this.clientFor(id);
    const q = this.store.records(id, 'question').find(x => x.id === body?.questionId);
    if (!q || q.status !== 'pending' || q.generation !== client.generation) throw new ConflictException('만료되거나 처리된 승인 요청입니다');
    if (q.kind !== 'approval' || !['accept', 'decline'].includes(body.decision)) throw new BadRequestException('올바른 승인 응답이 아닙니다');
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'];
    if (!supported.includes(q.method)) throw new BadRequestException('지원하지 않는 승인 유형입니다');
    const elicitation = q.method === 'mcpServer/elicitation/request';
    if (elicitation && body.decision === 'accept' &&
      (!['form', 'openai/form', 'openaiForm'].includes(q.params.mode) || q.params.requestedSchema?.type !== 'object' ||
        !q.params.requestedSchema.properties || Object.keys(q.params.requestedSchema.properties).length)) {
      throw new BadRequestException('추가 입력이나 외부 인증이 필요한 요청입니다. 단순 승인으로 처리할 수 없습니다.');
    }
    const response = elicitation ? { action: body.decision, content: body.decision === 'accept' ? {} : null, _meta: null }
      : q.method === 'item/permissions/requestApproval' ? { permissions: body.decision === 'accept' ? q.params.permissions : {}, scope: 'turn' } : { decision: body.decision };
    this.store.record(q.id, id, 'question', { ...q, status: 'sending', decision: body.decision });
    try { client.respond(q.requestId, response); }
    catch (error: any) { this.store.record(q.id, id, 'question', { ...q, status: 'uncertain', decision: body.decision }); throw new ConflictException(error.message); }
    this.store.record(q.id, id, 'question', { ...q, status: 'answered', decision: body.decision });
    const work = this.store.get(id)!; work.state = 'running'; this.store.save(work); this.store.event(id, 'approval', { questionId: q.id, decision: body.decision }); return { ok: true };
  }
  private documentVersions(work: Work) {
    const source = this.legacy.source(work.sourceId).path;
      let root = work.executionPath && !['completed', 'archived'].includes(work.phase) ? within(new FileResults(this.store).path(work), `openspec/changes/${work.changeName}`) : within(source, `changes/${work.changeName}`);
    try {
      if (!existsSync(root)) root = within(source, `changes/archive/${this.legacy.detail(`${work.sourceId}/${work.changeName}`).name}`);
      const paths = ['proposal.md', 'design.md', 'tasks.md', ...markdownFiles(join(root, 'specs')).map(x => `specs/${x}`)];
      return Object.fromEntries(paths.map(path => { const content = textFile(within(root, path)); return [path, content === null ? '' : createHash('sha256').update(content).digest('hex')]; }));
    } catch (error: any) {
      if (error.code === 'ENOENT' || error instanceof NotFoundException) return {};
      throw error;
    }
  }
  requireReviewedPlan(work: Work) {
    if (work.executionPath) new FileResults(this.store).assertSourcePlan(work);
    const root = work.executionPath ? within(new FileResults(this.store).path(work), `openspec/changes/${work.changeName}`) : within(this.legacy.source(work.sourceId).path, `changes/${work.changeName}`);
    const paths = ['proposal.md', 'design.md', 'tasks.md', ...markdownFiles(join(root, 'specs')).map(path => `specs/${path}`)].filter(path => textFile(within(root, path)) !== null);
    const version = createHash('sha256').update(paths.map(path => `${path}\n${textFile(within(root, path))!.replace(/- \[[xX ]\]/g, '- [ ]')}`).join('\n')).digest('hex');
    if (!work.reviewedVersion || work.reviewedVersion !== version || this.store.records(work.id, 'question').some(unresolvedQuestion)) throw new ConflictException('구현 전 최신 문서 검토와 질문 해결이 필요합니다. 문서 수정은 계획 작성·수정에서 진행해 주세요.');
  }
  private async drain(id: string) {
    if (this.closing || desktopHealth(this.store).safeMode || this.draining.has(id) || this.locks.has(id)) return;
    const work = this.store.get(id); if (!work || (work.toolId && work.toolId !== 'codex') || work.state !== 'idle' || ['completed', 'archived'].includes(work.phase)) return;
    const queued = this.store.records(id, 'queued-message').find(x => x.status === 'queued'); if (!queued) return;
    this.draining.add(id); this.store.record(queued.id, id, 'queued-message', { ...queued, status: 'dispatching' });
    try { await this.send(id, queued.text, queued.phase); this.store.record(queued.id, id, 'queued-message', { ...queued, status: 'sent' }); }
    catch (error: any) { const status = error instanceof ConflictException && this.store.get(id)?.state === 'idle' ? 'blocked' : 'uncertain'; this.store.record(queued.id, id, 'queued-message', { ...queued, status, error: error.message }); this.store.event(id, 'queue-stopped', { id: queued.id, status, error: error.message }); }
    finally { this.draining.delete(id); this.scheduleIdleDisposal(id); }
  }
  async interrupt(id: string) {
    const client = this.clientFor(id);
    const work = this.store.get(id)!; if (!work?.threadId || !work.turnId) throw new ConflictException('실행 중인 턴이 없습니다');
    this.edge.bridge.cancel(id);
    await this.browser.cancel(id);
    await client.rpc('turn/interrupt', { threadId: work.threadId, turnId: work.turnId }); return { requested: true };
  }
  private async browserCall(workId: string, message: any) {
    const client = this.clientFor(workId);
    const generation = client.generation;
    let response;
    try { response = edgeToolResponse(await this.edge.execute(workId, message.params.arguments)); }
    catch (error) { response = { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : 'Edge 요청 실패' }] }; }
    if (generation !== client.generation || this.closing) return;
    try { client.respond(message.id, response); }
    catch { return; } // A disconnected/expired request must never be answered in another process.
    this.store.event(workId, 'edge-tool-result', { op: message.params.arguments?.op, success: response.success });
  }
  private async backgroundCall(workId: string, message: any) {
    const client = this.clientFor(workId);
    const generation = client.generation;
    let response;
    try { response = backgroundToolResponse(await this.browser.tool(workId, message.params.arguments)); }
    catch (error) { response = { success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : '브라우저 검증 실패' }] }; }
    if (generation !== client.generation || this.closing) return;
    try { client.respond(message.id, response); } catch { return; }
    this.store.event(workId, 'browser-tool-result', { op: message.params.arguments?.op, success: response.success });
  }
  async onModuleDestroy() { this.closing = true; this.queueSubscription.unsubscribe(); for (const timer of this.idleTimers.values()) clearTimeout(timer); this.idleTimers.clear(); await Promise.all([...new Set([this.client, ...this.clients.values()])].map(async client => { client.removeAllListeners(); await client.close(); })); }
}
