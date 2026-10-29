import { realpathSync } from 'node:fs';
import { WorkStore, type Work } from '../work/store';
import { WorkspaceService } from '../work/workspace.service';
import { ProjectResolver } from './resolver';
import { ProjectGit } from './git';
import { ChangeBudget, workspaceChangedPaths, type ChangeBudgetOptions } from './workspace-changes';

const canonical = (path: string) => { const real = realpathSync(path); return process.platform === 'win32' ? real.toLowerCase() : real; };
const inactive = (work: Work) => ['completed', 'archived', 'cancelled', 'canceled'].includes(work.phase);

/** Advisory snapshots only: overlap neither acquires mutation locks nor predicts a merge. */
export class ProjectWorkspaceMetadata {
  constructor(private resolver: ProjectResolver, private store: WorkStore, private git: ProjectGit, private budgetOptions: ChangeBudgetOptions = {}) {}
  async read(sourceId: string, workId?: string) {
    const original = this.resolver.resolve(sourceId), selected = workId ? this.resolver.resolve(sourceId, workId) : original;
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
    if (work) { try { selectedPaths = await changed(work, selected.root); } catch { partial = true; } }
    const compare = (id: string | null, title: string, paths: Set<string>) => {
      if (!selectedPaths) { partial = true; return; }
      const intersection = [...paths].filter(path => selectedPaths!.has(path)).sort();
      if (intersection.length) overlaps.push({ workId: id, title, paths: intersection });
    };
    for (const other of this.store.list()) {
      if (other.id === workId || other.sourceId !== sourceId || inactive(other) || !spaces.hasSpace(other)) continue;
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
    return { workId: workId ?? null, kind: location?.kind ?? 'original', executionPath: selected.root, baseCommit: work?.workspace?.baseCommit ?? null, workspaceBaselineCommit: work?.workspace?.workspaceBaselineCommit ?? null, branch, head, overlaps, partial, observedAt: new Date().toISOString() };
  }
}
