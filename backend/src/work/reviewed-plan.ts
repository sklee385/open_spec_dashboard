import { createHash } from 'node:crypto';
import type { Work } from './store';
import { collectWorkspaceDocuments } from './workspace-documents';

export function fullReviewedPlan(work: Work, projectRoot: string) {
  return work.workspace?.kind === 'git-worktree' && !['completed', 'archived'].includes(work.phase) ? collectWorkspaceDocuments(projectRoot, work.changeName).planRevision : undefined;
}
/** Preserve existing review hashes while binding every imported planning document. */
export function bindReviewedPlan(work: Work, projectRoot: string, legacyVersion: string) {
  const current = fullReviewedPlan(work, projectRoot);
  if (!current || current === (work.reviewedPlanRevision ?? work.workspace?.sourcePlanRevision)) return legacyVersion;
  return createHash('sha256').update(`${legacyVersion}\0${current}`).digest('hex');
}
