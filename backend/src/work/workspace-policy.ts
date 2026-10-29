import { ConflictException } from '@nestjs/common';
import { resolve } from 'node:path';
import { desktopHealth } from '../desktop/health';
import type { Work, WorkStore } from './store';
import type { WorkspacePolicy } from './workspace-settings.service';
const activeStates = new Set(['preparing', 'connecting', 'creating-thread', 'running', 'waiting-input', 'waiting-approval']);
export function assertActiveCapacity(work: Work, policy: WorkspacePolicy, store: WorkStore) {
  const applies = (owner: Work) => owner.workspace?.status === 'preparing' || ['implementation', 'verification'].includes(owner.phase);
  if (!applies(work)) return;
  const active = (owner: Work) => {
    if (!applies(owner) || ['completed', 'archived'].includes(owner.phase)) return false;
    const runtime = desktopHealth(store).runtime(owner);
    return runtime !== 'inactive' || activeStates.has(owner.state) || owner.workspace?.status === 'preparing' || store.records(owner.id, 'question').some(row => ['pending', 'sending', 'recovering', 'uncertain'].includes(row.status)) || ['verification', 'browser-verification'].some(kind => store.records(owner.id, kind).some(row => row.status === 'running'));
  };
  const owners = store.list();
  if (owners.some(owner => owner.id === work.id && active(owner))) return;
  if (owners.filter(active).length >= policy.maxActiveWorks) throw new ConflictException({ message: '동시 활성 업무 한도에 도달했습니다. 기존 실행을 유지하며 새 실행은 대기합니다.', errorCode: 'workspace-active-limit' });
}
export function assertPreparationCapacity(selection: { confirmed: boolean; available: boolean; freeBytes: number | null }, policy: WorkspacePolicy) {
  if (!selection.confirmed || !selection.available) throw new ConflictException('확인된 작업 공간 루트를 먼저 설정해 주세요.');
  if (selection.freeBytes === null || !Number.isSafeInteger(selection.freeBytes) || selection.freeBytes < policy.minimumFreeBytes) throw new ConflictException({ message: '잔여 용량이 미확인이거나 최소 잔여 용량보다 부족합니다. 새 준비를 중단합니다.', errorCode: 'workspace-capacity' });
}
export function assertCandidateCapacity(commonDir: string, candidates: { id: string; commonDir: string; status: string }[], requestId?: string) {
  const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  if (candidates.some(candidate => candidate.id !== requestId && canonical(candidate.commonDir) === canonical(commonDir) && !['applied', 'cancelled', 'removed'].includes(candidate.status))) throw new ConflictException('저장소에 활성 통합 후보가 있습니다. 기존 후보를 먼저 확인해 주세요.');
}
export function retentionSuggestion(completedAt: string, policy: WorkspacePolicy, now = Date.now()) {
  const completed = Date.parse(completedAt), expires = completed + policy.retentionDays * 86400000;
  return { suggested: Number.isFinite(expires) && now >= expires, automatic: false as const, expiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null };
}
