import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ProjectResolver } from '../projects/resolver';
import { WorkStore, type Work } from '../work/store';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface BrowserExecutionContext {
  version: 1; contextId: string; workId: string; sourceId: string; threadId: string | null; turnId: string | null;
  scenarioVersion: string; sourceMutationVersion: unknown; executionContext: string;
  candidateId: string | null; targetKind: 'work' | 'integration-candidate'; executionPath: string | null; workExecutionPath: string | null;
  selectionVersion: string; selectionCurrent: boolean; requestId?: string;
}

/** Host-only target state. The context ID is a stale guard, never a capability
 * proving CLI trust, stopped writers, snapshot ownership or executable readiness. */
export class BrowserExecutionContexts {
  constructor(private store: WorkStore, private resolver: ProjectResolver, private execution: (work: Work) => string) {}
  private record(id: string) { const row = this.store.db.prepare('SELECT work_id,data FROM records WHERE id=?').get(id) as { work_id: string; data: string } | undefined; return row ? { ...JSON.parse(row.data), workId: row.work_id } : undefined; }
  private work(id: string) { const work = this.store.get(id); if (!work) throw new ConflictException('브라우저 요청 업무가 없습니다'); return work; }
  private target(work: Work, candidateId?: string) {
    const request = candidateId ? this.store.integrationRequests().find(row => row.workId === work.id && row.candidateId === candidateId) : undefined;
    const root = candidateId ? request?.executionPath ?? null : work.executionPath ?? null;
    const version = digest([work.id, work.sourceId, work.projectPath, work.executionPath ?? null, work.workspace?.workspaceId ?? null, candidateId ?? null, request ? [request.id, request.fingerprint, request.candidateMutationVersion ?? null, request.candidateCommit, request.targetBranch, request.targetHead, request.resultCommit, request.commonDir] : null, root]);
    return { root, version };
  }
  /** Called only by the existing explicit user run path, never AI input. */
  select(workId: string, candidateId?: string) {
    const work = this.work(workId), selected = this.resolver.resolve(work.sourceId, workId, candidateId), target = this.target(work, candidateId);
    if (selected.root !== target.root) throw new ConflictException('승인된 검증 대상 경로가 다릅니다');
    this.store.record(`browser-target:${workId}`, workId, 'browser-target', { candidateId: candidateId ?? null, executionPath: selected.root, version: target.version });
    return this.current(workId);
  }
  current(workId: string): BrowserExecutionContext {
    const work = this.work(workId), selected = this.record(`browser-target:${workId}`), candidateId = selected?.candidateId ?? null, target = this.target(work, candidateId ?? undefined);
    const value = {
      version: 1 as const, workId, sourceId: work.sourceId, threadId: work.threadId, turnId: work.turnId ?? null,
      scenarioVersion: digest(work.browserScenario), sourceMutationVersion: work.sourceMutationVersion ?? null, executionContext: this.execution(work),
      candidateId, targetKind: candidateId ? 'integration-candidate' as const : 'work' as const,
      executionPath: selected?.executionPath ?? target.root, workExecutionPath: work.executionPath ?? null,
      selectionVersion: selected?.version ?? target.version, selectionCurrent: !selected || selected.version === target.version,
    };
    const contextId = digest(value), context = { ...value, contextId };
    if (!this.record(`browser-context:${contextId}`)) this.store.record(`browser-context:${contextId}`, workId, 'browser-context', context);
    return context;
  }
  load(workId: string, contextId: string) {
    if (!/^[a-f0-9]{64}$/.test(contextId)) throw new ConflictException('호스트 브라우저 실행 컨텍스트가 없습니다');
    const context = this.record(`browser-context:${contextId}`);
    if (!context || context.workId !== workId || context.contextId !== contextId) throw new ConflictException('다른 업무 또는 확인되지 않은 브라우저 컨텍스트입니다');
    return context as BrowserExecutionContext;
  }
  isCurrent(context: BrowserExecutionContext) { return this.current(context.workId).contextId === context.contextId; }
  assertRun(context: BrowserExecutionContext) {
    const saved = this.load(context.workId, context.contextId);
    if (!saved.selectionCurrent || !this.isCurrent(saved)) throw new ConflictException('브라우저 대상·대화·턴 또는 세대가 변경되었습니다. 이전 run을 반복하지 않습니다');
    const work = this.work(context.workId), selected = this.resolver.resolve(work.sourceId, work.id, context.candidateId ?? undefined);
    if (selected.root !== saved.executionPath) throw new ConflictException('브라우저 대상의 현재 소유 경로를 확인할 수 없습니다');
  }
}
