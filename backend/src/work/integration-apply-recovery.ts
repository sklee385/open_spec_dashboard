import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { WorkStore, type IntegrationRequest } from './store';
import { IntegrationApply } from './integration-apply';
import { IntegrationApplyPreflight } from './integration-apply-preflight';
import { liveApply, terminatedApply } from './integration-apply-state';
import { projectCoordinator } from '../projects/coordinator';
import type { RecoveryIntent } from '../projects/operation-locks';
import { DesktopLifecycle } from '../desktop/lifecycle';
import { candidateBranch } from './integration-candidate';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Logical recovery/cancellation only: no Git mutation, process adoption or PID termination. */
@Injectable()
export class IntegrationApplyRecovery {
  constructor(@Inject(WorkStore) private store: WorkStore, @Inject(IntegrationApply) private applying: IntegrationApply,
    @Inject(IntegrationApplyPreflight) private preflight: IntegrationApplyPreflight, @Inject(DesktopLifecycle) private lifecycle: DesktopLifecycle) {}
  private rows(workId: string, candidateId: string) { return this.store.records(workId, 'integration-apply').filter(row => row.candidateId === candidateId); }
  private request(workId: string, candidateId: string) {
    const work = this.store.get(workId), request = this.store.integrationRequests().find(row => row.workId === workId && row.candidateId === candidateId);
    if (!work || !request) throw new NotFoundException('업무에 연결된 후보가 없습니다');
    if (request.projectPath !== work.projectPath || request.workspaceId !== work.workspace?.workspaceId || request.workExecutionPath !== work.executionPath || request.commonDir !== work.workspace?.commonDir || request.projectId !== work.workspace?.projectId) throw new ConflictException('저장된 후보의 업무 소유가 변경되었습니다');
    return { work, request };
  }
  private intent(row: any) { return row ? this.store.records(row.workId, 'workspace-git-intent').find(intent => intent.id === row.intentId) : undefined; }
  private live(workId: string, candidateId: string, row: any) {
    if (liveApply(this.store, workId, candidateId)) return { state: 'active' };
    if (row && !terminatedApply(row, this.intent(row))) return { state: 'unknown', reason: '종료 프로토콜 또는 소유 Job 종료 근거를 확인할 수 없습니다' };
    return { state: 'settled' };
  }
  async status(workId: string, candidateId: string, query: any = {}) {
    if (!query || Object.keys(query).some(key => key !== 'inspect') || query.inspect !== undefined && query.inspect !== '1') throw new BadRequestException('실제 관측은 inspect=1만 허용합니다');
    const { request } = this.request(workId, candidateId), rows = this.rows(workId, candidateId), row = rows.at(-1), live = this.live(workId, candidateId, row);
    let observation: any = { state: 'not-checked', ...(row?.lastObservation ? { last: row.lastObservation } : {}) };
    if (query.inspect === '1') {
      try {
        this.preflight.inspectOwnership(workId, candidateId, true);
        const inspected = await this.applying.inspectAttempt(row, request); inspected.assertUnchanged(); observation = inspected.observation;
        if (live.state !== 'settled') observation = { ...observation, gitState: observation.state, state: 'uncertain', reason: live.reason ?? '실제 적용 실행이 진행 중입니다' };
      } catch (error: any) { observation = { state: 'uncertain', reason: error.message, checkedAt: new Date().toISOString() }; }
    }
    return { candidateId, receipt: row ?? null, receipts: rows, live, observation };
  }
  private parse(body: any, reconcile: boolean) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirmed !== true || Object.keys(body).some(key => !['confirmed', ...(reconcile ? ['requestKey'] : [])].includes(key)) || reconcile && (typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(body.requestKey))) throw new BadRequestException('기존 적용 키와 명시 확인만 지정해 주세요');
    return body as { requestKey: string; confirmed: true };
  }
  private assertCurrent(request: IntegrationRequest, row: any, rows: any[]) {
    if (rows.at(-1)?.id !== row.id || row.requestId !== request.id || row.candidateCommit !== request.candidateCommit || row.candidateEpoch !== (request.candidateMutationVersion ?? null) || row.targetHead !== request.targetHead || row.targetBranch !== request.targetBranch || ['cancelled', 'removed'].includes(request.status) || row.commandStarted === true && (request as any).applyAttemptId !== row.id) throw new ConflictException('현재 후보의 적용 세대가 변경되었습니다. 이전 요청으로 덮지 않습니다');
  }
  private recoveryIntent(request: IntegrationRequest, row: any, intent: any): RecoveryIntent {
    const branch = this.store.get(row.workId)?.workspace?.branch;
    if (!intent || intent.stage !== 'integration-apply' || intent.scope !== 'integration' || intent.root !== request.projectPath || intent.commonDir !== request.commonDir || hash(intent.affectedRoots) !== hash([request.workExecutionPath, request.executionPath]) || hash(intent.refs) !== hash([`refs/heads/${request.targetBranch}`, `refs/heads/${branch}`, `refs/heads/${candidateBranch(request)}`]) || !terminatedApply(row, intent)) throw new ConflictException('소유한 적용 실행의 종료 근거를 확인할 수 없습니다');
    return { workId: row.workId, id: intent.id, owner: intent.owner, runGeneration: intent.runGeneration, digest: hash(intent) };
  }
  async reconcile(workId: string, candidateId: string, body: unknown) {
    const input = this.parse(body, true), { work, request } = this.request(workId, candidateId), rows = this.rows(workId, candidateId), row = rows.find(row => row.requestKey === input.requestKey);
    if (!row) throw new NotFoundException('기존 적용 키의 영수증이 없습니다');
    this.assertCurrent(request, row, rows);
    if (liveApply(this.store, workId, candidateId)) throw new ConflictException('소유한 적용 실행이 진행 중입니다');
    const intent = this.intent(row), recovery = this.recoveryIntent(request, row, intent), owned = this.preflight.inspectOwnership(workId, candidateId);
    this.lifecycle.assertUnlocked(); const settle = this.lifecycle.beginRequest('integration-reconcile', workId); let release: (() => void) | undefined;
    const snapshot = hash([work, request, rows, intent]);
    try {
      release = projectCoordinator(this.store).acquireRecovery(owned.plan, recovery);
      const observed = await this.applying.inspectAttempt(row, request);
      let receipt: any;
      this.store.transaction(() => {
        const current = this.request(workId, candidateId), currentRows = this.rows(workId, candidateId), currentRow = currentRows.find(item => item.id === row.id), currentIntent = this.intent(currentRow);
        if (hash([current.work, current.request, currentRows, currentIntent]) !== snapshot || liveApply(this.store, workId, candidateId)) throw new ConflictException('실제 상태 확인 중 적용 세대·소유·intent가 변경되었습니다');
        this.assertCurrent(current.request, currentRow, currentRows); projectCoordinator(this.store).assertRecovery(owned.plan, recovery);
        this.preflight.inspectOwnership(workId, candidateId); observed.assertUnchanged();
        // An applied receipt is historical evidence, even if an external writer moved on.
        if (row.status === 'applied') { receipt = row; return; }
        const state = observed.observation.state;
        receipt = { ...row, status: state, applied: state === 'applied', ...(state === 'applied' ? { appliedCommit: row.candidateCommit } : {}), observedHead: observed.observation.head, lastObservation: observed.observation, reconciledAt: new Date().toISOString(), reconciledFromStatus: row.status };
        this.store.record(row.id, workId, 'integration-apply', receipt);
        this.store.record(intent.id, workId, 'workspace-git-intent', { ...intent, status: state === 'applied' ? 'passed' : state, ...(state !== 'uncertain' ? { reconciledAt: receipt.reconciledAt } : {}) });
        this.store.record(request.id, workId, 'integration-request', { ...current.request, status: state === 'failed' ? 'validating' : state, ...(state === 'applied' ? { appliedCommit: row.candidateCommit } : {}), error: state === 'uncertain' ? observed.observation.reason : undefined, updatedAt: receipt.reconciledAt });
      });
      return { reconciled: row.status !== 'applied', receipt, live: this.live(workId, candidateId, receipt), observation: observed.observation };
    } finally { release?.(); settle(); }
  }
  async cancel(workId: string, candidateId: string, body: unknown) {
    this.parse(body, false); const { work, request } = this.request(workId, candidateId), rows = this.rows(workId, candidateId);
    if (request.status === 'applied') return { cancelled: false, alreadyApplied: true, appliedCommit: request.appliedCommit };
    if (request.status === 'cancelled') return { cancelled: true, alreadyCancelled: true, candidateId };
    if (this.live(workId, candidateId, rows.at(-1)).state !== 'settled') throw new ConflictException('진행 중이거나 종료 미확인인 적용 실행을 논리 취소로 해제할 수 없습니다');
    const owned = this.preflight.inspectOwnership(workId, candidateId, true), snapshot = hash([work, request, rows]);
    this.lifecycle.assertUnlocked(); const release = projectCoordinator(this.store).acquireOperation(owned.plan);
    try {
      return this.store.transaction(() => {
        const current = this.request(workId, candidateId);
        if (hash([current.work, current.request, this.rows(workId, candidateId)]) !== snapshot || liveApply(this.store, workId, candidateId)) throw new ConflictException('취소 확인 중 후보 또는 적용 세대가 변경되었습니다');
        projectCoordinator(this.store).assertRecovery(owned.plan); this.preflight.inspectOwnership(workId, candidateId, true);
        const cancelledAt = new Date().toISOString();
        this.store.record(request.id, workId, 'integration-request', { ...current.request, status: 'cancelled', cancelledAt, updatedAt: cancelledAt });
        return { cancelled: true, alreadyApplied: false, candidateId };
      });
    } finally { release(); }
  }
}
