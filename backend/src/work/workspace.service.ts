import { ConflictException } from '@nestjs/common';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Work, WorkStore, WorkWorkspace } from './store';
import { inspectWorkspacePath } from './workspace-paths';
import { readWorkspaceRoot } from './workspace-root';
import { createHash, randomUUID } from 'node:crypto';
import type { WorkspaceSettingsService } from './workspace-settings.service';
import { assertActiveCapacity, assertPreparationCapacity } from './workspace-policy';
import { WorkspacePreparation, type PreparationOptions, type PreparationStage } from './workspace-preparation';
import { verifyWorktreeRegistration } from './worktree-registration';
import { preflightGitDirectoryPath } from './git-path-preflight';

export interface WorkspaceLocation {
  kind: 'copy' | 'git-worktree'; legacy: boolean; rootId: string | null;
  workspaceId: string | null; executionPath: string | null; status: string;
}
interface WorkspaceOptions {
  preparation?: PreparationOptions;
  protectedPaths?: () => string[];
  verifyGit?: (work: Work, space: WorkWorkspace) => void;
}
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

/** Resolves persisted ownership. Reading settings never relocates an existing workspace. */
export class WorkspaceService {
  constructor(private store: WorkStore, private options: WorkspaceOptions = {}) {}
  prepareStage<T>(work: Work, path: string, stage: PreparationStage, operation: () => T) { return new WorkspacePreparation(this.store, this.options.preparation).run(work, path, stage, operation); }
  reserve(work: Work, settings: WorkspaceSettingsService, kind: WorkWorkspace['kind']): WorkWorkspace {
    return settings.withSelectedRoot(selected => {
      const space = this.planReservation(work, selected, kind);
      work.workspace = space; work.executionPath = space.executionPath; this.store.save(work);
      return space;
    });
  }
  /** Read-only planning before recording a request; reserve repeats it under the settings lock. */
  preflightReservation(work: Work, settings: WorkspaceSettingsService, kind: WorkWorkspace['kind']): WorkWorkspace {
    return this.planReservation(work, settings.view(), kind);
  }
  private planReservation(work: Work, selected: ReturnType<WorkspaceSettingsService['view']>, kind: WorkWorkspace['kind']): WorkWorkspace {
    if (!['copy', 'git-worktree'].includes(kind) || this.hasSpace(work)) throw new ConflictException('기존 공간이 있거나 공간 종류가 올바르지 않습니다.');
    const persisted = this.store.get(work.id);
    if (!persisted || this.hasSpace(persisted)) throw new ConflictException('업무가 없거나 이미 공간을 준비했습니다. 최신 상태를 확인해 주세요.');
    assertActiveCapacity({ ...work, phase: 'implementation' }, selected.policy, this.store);
    assertPreparationCapacity(selected, selected.policy);
    if (!selected.available || !selected.confirmed || !selected.path || !selected.managedPath) throw new ConflictException('확인된 작업 공간 루트를 먼저 설정해 주세요.');
    const root = selected.roots.find(root => root.rootId === selected.selectedRootId)!;
    const projectId = createHash('sha256').update(realpathSync(work.projectPath)).digest('hex'), workspaceId = randomUUID();
    const space: WorkWorkspace = { version: 1, kind, status: 'preparing', profileId: selected.profileId, rootId: root.rootId, rootPath: root.path, managedPath: root.managedPath, projectId, workspaceId, executionPath: join(root.managedPath, 'projects', projectId, 'works', workspaceId, 'project'), preparationPolicyVersion: selected.version };
    if (kind === 'git-worktree') preflightGitDirectoryPath(space.executionPath);
    return space;
  }
  hasSpace(work: Work) { return work.workspace !== undefined || !!work.executionPath || this.store.records(work.id, 'isolated-baseline').length > 0; }
  queryPath(work: Work) { return !['completed', 'archived'].includes(work.phase) && this.hasSpace(work) ? this.path(work) : work.projectPath; }
  describe(work: Work): WorkspaceLocation | null {
    if (work.workspace !== undefined) {
      const space = work.workspace;
      if (!space || !['copy', 'git-worktree'].includes(space.kind)) throw this.unavailable();
      return { kind: space.kind, legacy: false, rootId: space.rootId, workspaceId: space.workspaceId, executionPath: space.executionPath, status: space.status };
    }
    if (!this.hasSpace(work)) return null;
    return { kind: 'copy', legacy: true, rootId: null, workspaceId: null, executionPath: work.executionPath || null, status: 'ready' };
  }
  path(work: Work): string {
    try {
      if (this.store.records(work.id, 'workspace-preparation').some(record => record.status === 'failed')) throw new Error('preparation failed');
      if (work.workspace !== undefined) return this.managedPath(work, work.workspace);
      const base = this.store.records(work.id, 'isolated-baseline')[0], path = work.executionPath;
      if (!base || !path || base.executionPath !== path) throw new Error('baseline');
      this.assertDirectory(path);
      const rel = relative(resolve(work.projectPath), resolve(path));
      if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) throw new Error('original project');
      const identity = this.identity(join(dirname(path), 'identity.json'));
      if (identity.workId !== work.id || identity.projectPath !== work.projectPath) throw new Error('ownership');
      return path;
    } catch { throw this.unavailable(); }
  }
  recoveryPath(work: Work): string {
    if (this.hasSpace(work)) return this.path(work);
    if (!statSync(work.projectPath).isDirectory()) throw new Error('프로젝트 폴더를 확인해 주세요');
    return work.projectPath;
  }
  private managedPath(work: Work, space: WorkWorkspace): string {
    if (!space || space.version !== 1 || !['copy', 'git-worktree'].includes(space.kind) || space.status !== 'ready' || !uuid(space.profileId) || !uuid(space.rootId) || !uuid(space.workspaceId) || !/^[a-f0-9]{64}$/.test(space.projectId) || typeof space.rootPath !== 'string' || !isAbsolute(space.rootPath) || work.executionPath !== space.executionPath) throw new Error('workspace record');
    const protectedPaths = [...(this.options.protectedPaths?.() ?? [resolve(__dirname, '../../..'), dirname(resolve(process.env.CONFIG_PATH || process.env.OPENSPEC_UI_CONFIG || '../config.local.json')), resolve(process.env.DATA_DIR || '../.data')]), work.projectPath];
    const root = readWorkspaceRoot(space.rootPath, protectedPaths, space.profileId);
    if (root.rootId !== space.rootId || root.managedPath !== space.managedPath) throw new Error('root');
    const container = join(space.managedPath, 'projects', space.projectId, 'works', space.workspaceId);
    if (space.executionPath !== join(container, 'project')) throw new Error('fixed path');
    inspectWorkspacePath(space.executionPath, protectedPaths); this.assertDirectory(space.executionPath);
    const identity = this.identity(join(container, 'identity.json'));
    if (identity.schemaVersion !== 1 || identity.workId !== work.id || identity.projectPath !== work.projectPath || identity.kind !== space.kind || identity.profileId !== space.profileId || identity.rootId !== space.rootId || identity.projectId !== space.projectId || identity.workspaceId !== space.workspaceId || identity.executionPath !== space.executionPath) throw new Error('workspace ownership');
    if (space.kind === 'git-worktree') {
      if (identity.commonDir !== space.commonDir || identity.branch !== space.branch) throw new Error('Git ownership');
      (this.options.verifyGit ?? verifyWorktreeRegistration)(work, space);
    }
    return space.executionPath;
  }
  private assertDirectory(path: string) {
    if (!isAbsolute(path) || !samePath(realpathSync(path), path)) throw new Error('real path');
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('directory');
  }
  private identity(path: string) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error('identity file');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  private unavailable() { return new ConflictException('업무 전용 공간의 식별 정보가 없거나 달라 복구가 필요합니다'); }
}
