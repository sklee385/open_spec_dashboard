import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { WorkStore, Work, IntegrationRequest } from './store';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type CompletionRef = { id: string; kind: 'verification' | 'candidate-verification' | 'browser-verification'; digest: string };
/** Small immutable anchors, captured inside the apply admission transaction. No log/image copies. */
export function captureCompletionProof(store: WorkStore, work: Work, request: IntegrationRequest, candidateRefs: string[]) {
  const removed = work.workspace?.status === 'removed' && store.db.prepare("SELECT 1 FROM records WHERE work_id=? AND kind='workspace-cleanup' AND json_extract(data,'$.targetKind')='work' AND json_extract(data,'$.workspaceId')=? AND json_extract(data,'$.target.path')=? AND json_extract(data,'$.status')='removed' AND json_extract(data,'$.processTerminated')=1 AND json_extract(data,'$.keepBranch')=1 LIMIT 1").get(work.id,work.workspace.workspaceId,work.workspace.executionPath);
  const workspace = removed ? { ...work.workspace!, status: 'ready' } : work.workspace;
  const basis = hash([work.sourceId, work.projectPath, work.executionPath, workspace, work.reviewedVersion, work.sourceMutationVersion ?? null, work.verificationCommands ?? null, work.browserScenario ?? null,
    request.id, request.candidateId, request.candidateMutationVersion ?? null, request.candidateCommit, request.targetBranch, request.targetHead, request.resultCommit, request.sourceRevision, request.reviewedVersion, request.workVerificationRefs, candidateRefs]);
  const refs: CompletionRef[] = [];
  for (const [ids, candidate] of [[request.workVerificationRefs, false], [candidateRefs, true]] as const) {
    if (!ids.length || ids.length > 256) return { version: 1, state: 'unavailable', reason: '적용 당시 검증 참조가 없습니다' };
    for (const id of ids) {
      const saved = store.db.prepare('SELECT id,kind,data FROM records WHERE work_id=? AND id=?').get(work.id, id) as { id: string; kind: string; data: string } | undefined;
      if (!saved || !['verification', 'candidate-verification', 'browser-verification'].includes(saved.kind)) return { version: 1, state: 'unavailable', reason: '적용 당시 검증 참조를 확인할 수 없습니다' };
      const row = JSON.parse(saved.data);
      if (row.status !== 'passed' || candidate && (row.candidateId !== request.candidateId || row.processTerminated !== true) || !candidate && row.candidateId != null || candidate && saved.kind === 'verification' || !candidate && saved.kind === 'candidate-verification') return { version: 1, state: 'unavailable', reason: '적용 당시 검증 소유 또는 통과 근거가 없습니다' };
      if (!refs.some(ref => ref.id === id)) refs.push({ id, kind: saved.kind as CompletionRef['kind'], digest: hash({ ...row, id: saved.id }) });
    }
  }
  return { version: 1, state: 'anchored', basis, refs };
}
export function requireCompletionProof(store: WorkStore, work: Work, request: IntegrationRequest, row: any): CompletionRef[] {
  if (row.completionProof?.version !== 1 || row.completionProof?.state !== 'anchored') throw new ConflictException('적용 당시 완료 검증의 고정 근거가 없습니다. 반영 이력은 보존하며 자동으로 재반영하지 않습니다');
  const current = captureCompletionProof(store, work, request, row.verificationRefs ?? []);
  if (hash(current) !== hash(row.completionProof)) throw new ConflictException('적용 당시 검증·계획·설정 또는 참조 근거가 변경되었습니다');
  return row.completionProof.refs;
}
