import { realpathSync } from 'node:fs';
import { WorkStore, type Work } from '../work/store';
import { WorkspaceService } from '../work/workspace.service';
import { ProjectResolver } from './resolver';
import { ProjectGit } from './git';
import { ChangeBudget, workspaceChangedPaths, type ChangeBudgetOptions } from './workspace-changes';
import { ConflictException } from '@nestjs/common';
import { candidateBranch } from '../work/integration-candidate';

const canonical = (path: string) => { const real = realpathSync(path); return process.platform === 'win32' ? real.toLowerCase() : real; };
const inactive = (work: Work) => ['completed', 'archived', 'cancelled', 'canceled'].includes(work.phase);

/** Advisory snapshots only: overlap neither acquires mutation locks nor predicts a merge. */
export class ProjectWorkspaceMetadata {
  constructor(private resolver: ProjectResolver, private store: WorkStore, private git: ProjectGit, private budgetOptions: ChangeBudgetOptions = {}) {}
  async read(sourceId: string, workId?: string, candidateId?: string, candidateGitBlockedReason?: string) {
    const original = this.resolver.resolve(sourceId), selected = workId || candidateId !== undefined ? this.resolver.resolve(sourceId, workId, candidateId) : original;
    const candidate = selected.candidate;
    // Preserve file-tree repair when status/diff would run unsupported clean conversion.
    if (candidate && candidateGitBlockedReason) return { workId: workId!, kind: 'integration-candidate', executionPath: selected.root, baseCommit: candidate.targetHead, workspaceBaselineCommit: candidate.targetHead, branch: candidateBranch(candidate), head: candidate.status === 'conflicted' ? candidate.targetHead : candidate.candidateCommit, overlaps: [], partial: true, partialReason: candidateGitBlockedReason, observedAt: new Date().toISOString(), candidateId: candidate.candidateId, integrationId: candidate.id, projectId: candidate.projectId, workspaceId: candidate.workspaceId, candidateStatus: candidate.status, candidateCommit: candidate.candidateCommit, targetHead: candidate.targetHead, resultCommit: candidate.resultCommit, readOnly: false, gitReadOnly: true, editContract: 'candidate-cas', candidateMutationVersion: candidate.candidateMutationVersion ?? null, changedPaths: [] };
    const work = workId ? this.store.get(workId)! : null, spaces = new WorkspaceService(this.store);
    const location = work ? spaces.describe(work) : null;
    const overlaps: { workId: string | null; title: string; paths: string[] }[] = [];
    let partial = false;
    const budget = new ChangeBudget(this.budgetOptions);
    const changed = async (item: Work, root: string) => {
      const result = await workspaceChangedPaths(item, root, this.store, budget);
      partial ||= result.partial;
      return result.paths;
    };
    let selectedPaths: Set<string> | null = null, branch: string | null = null, head: string | null = null;
    try { const status = await this.git.status(selected.root); branch = status.branch; head = status.head; if (!work) { selectedPaths = status.available ? new Set(status.entries.flatMap(entry => [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])])) : null; partial ||= !status.available || !!status.hiddenChanges || !!status.blocked; } }
    catch { partial = true; }
    if (work) { try {
      // Candidate changes are measured against the frozen integration target, never the work baseline.
      const basis = candidate && work.workspace ? { ...work, workspace: { ...work.workspace, workspaceBaselineCommit: candidate.targetHead } } : work;
      selectedPaths = await changed(basis, selected.root);
    } catch { partial = true; } }
    const compare = (id: string | null, title: string, paths: Set<string>) => {
      if (!selectedPaths) { partial = true; return; }
      const intersection = [...paths].filter(path => selectedPaths!.has(path)).sort();
      if (intersection.length) overlaps.push({ workId: id, title, paths: intersection });
    };
    for (const other of this.store.list()) {
      if ((!candidate && other.id === workId) || other.sourceId !== sourceId || inactive(other) || !spaces.hasSpace(other)) continue;
      try {
        budget.check();
        if (canonical(other.projectPath) !== canonical(original.root)) { partial = true; continue; }
        // Same-source/canonical-project checks above plus the normal ownership resolver;
        // do not repeat ProjectResolver's unrelated synchronous Git metadata probes.
        compare(other.id, other.changeName, await changed(other, spaces.path(other)));
      } catch { partial = true; }
    }
    if (work) {
      try { const status = await this.git.status(original.root); if (status.available) { compare(null, 'original', new Set(status.entries.flatMap(entry => [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])]))); partial ||= !!status.hiddenChanges || !!status.blocked; } else partial = true; }
      catch { partial = true; }
    }
    if (candidate && JSON.stringify(this.resolver.resolve(sourceId, workId, candidateId).candidate) !== JSON.stringify(candidate)) throw new ConflictException('후보 조회 중 상태가 변경되었습니다');
    return { workId: workId ?? null, kind: candidate ? 'integration-candidate' : location?.kind ?? 'original', executionPath: selected.root, baseCommit: candidate?.targetHead ?? work?.workspace?.baseCommit ?? null, workspaceBaselineCommit: candidate?.targetHead ?? work?.workspace?.workspaceBaselineCommit ?? null, branch, head, overlaps, partial, observedAt: new Date().toISOString(), ...(candidate ? { candidateId: candidate.candidateId, integrationId: candidate.id, projectId: candidate.projectId, workspaceId: candidate.workspaceId, candidateStatus: candidate.status, candidateCommit: candidate.candidateCommit, targetHead: candidate.targetHead, resultCommit: candidate.resultCommit, readOnly: false, gitReadOnly: true, editContract: 'candidate-cas', candidateMutationVersion: candidate.candidateMutationVersion ?? null, changedPaths: selectedPaths ? [...selectedPaths].sort() : [] } : {}) };
  }
}
