import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { desktopHealth } from '../desktop/health';
import type { Work, WorkStore } from './store';

export type ManagementState = 'automatic' | 'active' | 'completed' | 'archived';
type Scope = 'work' | 'run';
const states = new Set<ManagementState>(['automatic', 'active', 'completed', 'archived']);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function workManagement(store: WorkStore, workId: string) {
  return store.records(workId, 'management-state').find(row => row.scope === 'work') ?? { state: 'automatic', version: 0, scope: 'work' };
}

/** Administrative metadata only. Never mutates Work, execution owners, leases or evidence. */
export class WorkManagement {
  constructor(private readonly store: WorkStore) {}
  private work(id: string): Work { const work = this.store.get(id); if (!work) throw new NotFoundException('업무를 찾을 수 없습니다'); return work; }
  private scope(value: unknown): Scope { if (value !== 'work' && value !== 'run') throw new BadRequestException('업무 또는 현재 실행 범위를 선택해 주세요'); return value; }
  private observation(work: Work) { return hash([work.id, work.phase, work.state, work.turnId ?? null, work.updatedAt]); }
  status(id: string, value: unknown = 'work') {
    const scope = this.scope(value), work = this.work(id), runId = work.turnId ?? null;
    if (scope === 'run' && !runId) throw new ConflictException('현재 실행 회차가 없습니다. 업무 범위를 선택해 주세요');
    const current = this.store.records(id, 'management-state').find(row => row.scope === scope && (scope === 'work' || row.runId === runId));
    return { workId: id, sourceId: work.sourceId, changeName: work.changeName, scope, runId,
      state: current?.state ?? 'automatic', version: current?.version ?? 0, observation: this.observation(work),
      observed: { phase: work.phase, state: work.state, runtime: desktopHealth(this.store).runtime(work) },
      history: this.store.records(id, 'management-history').filter(row => row.scope === scope && (scope === 'work' || row.runId === runId)).slice(-20).reverse() };
  }
  change(id: string, body: any) {
    if (!body || !states.has(body.state) || typeof body.reason !== 'string' || body.reason.trim().length < 2 || body.reason.length > 500 || typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestKey) || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0 || typeof body.observation !== 'string') throw new BadRequestException('관리 상태·변경 사유·조회 버전·요청 식별자를 확인해 주세요');
    const scope = this.scope(body.scope), fingerprint = hash(body);
    return this.store.transaction(() => {
      const duplicate = this.store.records(id, 'management-history').find(row => row.requestKey === body.requestKey);
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint) throw new ConflictException('같은 요청 식별자로 다른 변경을 제출할 수 없습니다');
        return { ...this.status(id, scope), receipt: duplicate, replayed: true };
      }
      const current = this.status(id, scope);
      if (body.expectedVersion !== current.version || body.observation !== current.observation || body.runId !== current.runId) throw new ConflictException('업무 또는 관리 상태가 변경되었습니다. 최신 상태를 조회하고 다시 확인해 주세요');
      if (current.state === body.state) throw new ConflictException('현재와 다른 관리 상태를 선택해 주세요');
      if (body.state === 'archived' && current.state !== 'completed') throw new ConflictException('관리상 완료로 표시한 뒤 관리상 보관을 선택해 주세요');
      const receipt = { id: randomUUID(), workId: id, scope, runId: current.runId, before: current.state, after: body.state, version: current.version + 1,
        at: new Date().toISOString(), reason: body.reason.trim(), actor: 'local-user', requestKey: body.requestKey, fingerprint, observed: current.observed };
      const key = `management:${id}:${scope}:${scope === 'run' ? hash(current.runId) : 'all'}`;
      this.store.record(key, id, 'management-state', { state: body.state, version: receipt.version, scope, runId: current.runId });
      this.store.record(receipt.id, id, 'management-history', receipt);
      this.store.event(id, 'management-state-changed', { scope, runId: current.runId, before: receipt.before, after: receipt.after, version: receipt.version, at: receipt.at });
      return { ...this.status(id, scope), receipt, replayed: false };
    });
  }
}
