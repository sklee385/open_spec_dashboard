import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Work, WorkStore, type WorkWorkspace } from '../src/work/store';
import { WorkspaceService } from '../src/work/workspace.service';
import { inspectWorkspacePath } from '../src/work/workspace-paths';
import { registerWorkspaceRoot } from '../src/work/workspace-root';
import { FileResults } from '../src/work/file-results';
import { WorkRecovery } from '../src/work/recovery';

let dir: string, store: WorkStore, work: Work, spaces: WorkspaceService;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-service-'));
  const projectPath = join(dir, 'original'); mkdirSync(projectPath);
  process.env.DATA_DIR = join(dir, 'data'); store = new WorkStore();
  work = { id: 'work-a', sourceId: 'demo', projectPath, changeName: 'feature', requestKey: 'a', ideaIds: [], phase: 'implementation', state: 'idle', threadId: 'same-thread', reviewedVersion: 'plan-v1', createdAt: '', updatedAt: '' };
  store.save(work); spaces = new WorkspaceService(store, { protectedPaths: () => [work.projectPath, process.env.DATA_DIR!] });
});
afterEach(() => { store.onApplicationShutdown(); delete process.env.DATA_DIR; delete process.env.WORKSPACE_ROOT; });
function legacy() {
  const path = join(dir, 'old-root', 'owned', 'project'); mkdirSync(path, { recursive: true });
  writeFileSync(join(dirname(path), 'identity.json'), JSON.stringify({ workId: work.id, projectPath: work.projectPath }));
  work.executionPath = path; store.save(work);
  store.record('baseline-a', work.id, 'isolated-baseline', { version: 1, executionPath: path, files: {} });
  return path;
}
function managed() {
  const rootPath = join(dir, 'new-root'); mkdirSync(rootPath);
  const profileId = randomUUID(), root = registerWorkspaceRoot(inspectWorkspacePath(rootPath, []), [], profileId);
  const workspaceId = randomUUID(), projectId = 'a'.repeat(64);
  const containerPath = join(root.managedPath, 'projects', projectId, 'works', workspaceId), executionPath = join(containerPath, 'project');
  mkdirSync(executionPath, { recursive: true });
  const space: WorkWorkspace = { version: 1, kind: 'copy', status: 'ready', profileId, rootId: root.rootId, rootPath, managedPath: root.managedPath, projectId, workspaceId, executionPath };
  writeFileSync(join(containerPath, 'identity.json'), JSON.stringify({ schemaVersion: 1, workId: work.id, projectPath: work.projectPath, ...space }));
  work.workspace = space; work.executionPath = executionPath; store.save(work); return space;
}
it('과거 공유 baseline은 새 격리 기준으로 만들지 않고 대화와 원본 경로를 보존한다', () => {
  store.record('shared', work.id, 'baseline', { files: {} });
  const before = JSON.stringify(store.get(work.id));
  expect(spaces.describe(work)).toBeNull(); expect(spaces.recoveryPath(work)).toBe(work.projectPath);
  expect(() => spaces.path(work)).toThrow(/복구/);
  expect(JSON.stringify(store.get(work.id))).toBe(before);
});
it('과거 isolated-baseline은 새 루트 설정과 무관하게 원래 경로와 threadId를 보존한다', () => {
  const path = legacy(), before = JSON.stringify(store.get(work.id));
  process.env.WORKSPACE_ROOT = join(dir, 'changed-root');
  expect(spaces.describe(work)).toMatchObject({ kind: 'copy', legacy: true, rootId: null, workspaceId: null, executionPath: path });
  expect(spaces.path(work)).toBe(path); expect(spaces.recoveryPath(work)).toBe(path);
  expect(JSON.stringify(store.get(work.id))).toBe(before); expect(work.threadId).toBe('same-thread');
});
it('저장된 profile/root/workspace 식별과 경로를 왕복하며 기본 루트 변경으로 재계산하지 않는다', () => {
  const space = managed(), reloaded = store.get(work.id)!;
  expect(reloaded.workspace).toEqual(space);
  process.env.WORKSPACE_ROOT = join(dir, 'different');
  expect(spaces.describe(reloaded)).toMatchObject({ kind: 'copy', legacy: false, rootId: space.rootId, workspaceId: space.workspaceId });
  expect(spaces.path(reloaded)).toBe(space.executionPath);
  expect(reloaded.threadId).toBe('same-thread');
});
it('공간 유실·잘못된 소유·경로 변조는 원본 경로로 대체하지 않는다', () => {
  const space = managed();
  const identity = join(dirname(space.executionPath), 'identity.json'), original = readFileSync(identity, 'utf8');
  writeFileSync(identity, original.replace(work.id, 'other-work'));
  expect(() => spaces.recoveryPath(work)).toThrow(/복구/);
  writeFileSync(identity, original); renameSync(space.executionPath, `${space.executionPath}-preserved`);
  expect(() => spaces.path(work)).toThrow(/복구/);
  work.executionPath = work.projectPath; expect(() => spaces.path(work)).toThrow(/복구/);
});
it('Git 공간 식별을 저장하며 등록 검증 없이는 복사 공간으로 취급하지 않는다', () => {
  const space = managed();
  Object.assign(space, { kind: 'git-worktree', commonDir: join(dir, 'repo.git'), branch: 'work/a', baseCommit: 'base', workspaceBaselineCommit: 'baseline' });
  writeFileSync(join(dirname(space.executionPath), 'identity.json'), JSON.stringify({ schemaVersion: 1, workId: work.id, projectPath: work.projectPath, ...space }));
  store.save(work);
  const reloaded = store.get(work.id)!;
  expect(reloaded.workspace).toEqual(space);
  expect(spaces.describe(reloaded)?.kind).toBe('git-worktree');
  expect(() => spaces.path(reloaded)).toThrow(/복구/);
  let verified = false;
  const checked = new WorkspaceService(store, { protectedPaths: () => [work.projectPath], verifyGit: (owner, saved) => { expect(owner.id).toBe(work.id); expect(saved).toEqual(space); verified = true; } });
  expect(checked.path(reloaded)).toBe(space.executionPath); expect(verified).toBe(true);
  expect(reloaded.threadId).toBe('same-thread');
});
it('결과와 복구는 새 공간의 같은 소유 경로를 사용한다', () => {
  const space = managed();
  expect(new FileResults(store, spaces).path(work)).toBe(space.executionPath);
  const recovery = new WorkRecovery(store, spaces);
  expect(recovery.path(work)).toBe(space.executionPath);
  expect(recovery.status(work)).toMatchObject({ mode: 'isolated', canReconnect: true });
});
it('새 공간의 executionPath가 유실돼도 공유 원본으로 복구하지 않는다', () => {
  managed(); delete work.executionPath; store.save(work);
  const recovery = new WorkRecovery(store, spaces);
  expect(recovery.status(work)).toMatchObject({ mode: 'isolated', code: 'workspace-unavailable', canReconnect: false, required: true });
  expect(() => recovery.path(work)).toThrow(/복구/);
});
it('기존 복사 공간도 결과와 복구에서 경로와 대화를 유지한다', () => {
  const path = legacy();
  expect(new FileResults(store, spaces).path(work)).toBe(path);
  expect(new WorkRecovery(store, spaces).path(work)).toBe(path);
  expect(work.threadId).toBe('same-thread');
});
it('실험 생성 경로를 허용하면 새 Git 업무를 기존 복사 진입으로 우회하지 않는다', () => {
  process.env.OPENSPEC_WORKTREE_EXPERIMENTAL = '1';
  try {
    expect(() => new FileResults(store).prepare(work)).toThrow(/공간|준비/);
    expect(store.get(work.id)?.executionPath).toBeUndefined();
    const path = legacy(); expect(() => new FileResults(store).prepare(work)).not.toThrow(); expect(work.executionPath).toBe(path);
  } finally { delete process.env.OPENSPEC_WORKTREE_EXPERIMENTAL; }
});
