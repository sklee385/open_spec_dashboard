import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { WorkStore, type Work } from '../src/work/store';
import { FileResults } from '../src/work/file-results';
import { ProjectResolver } from '../src/projects/resolver';
import { ProjectWorkspaceMetadata } from '../src/projects/workspace-metadata';
import { ProjectGit } from '../src/projects/git';
import { registerWorkspaceRoot } from '../src/work/workspace-root';
import { inspectWorkspacePath } from '../src/work/workspace-paths';
import { gitEnvironment } from '../src/projects/git-runner';
import { ChangeBudget, workspaceChangedPaths } from '../src/projects/workspace-changes';

let root: string, store: WorkStore, resolver: ProjectResolver, metadata: ProjectWorkspaceMetadata;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', ...args], { cwd, env: gitEnvironment(), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 's-')); root = join(dir, 's'); mkdirSync(join(root, 'openspec'), { recursive: true });
  process.env.DATA_DIR = join(dir, 'data'); store = new WorkStore();
  writeFileSync(join(root, 'shared.txt'), 'base');
  resolver = new ProjectResolver({ sources: () => [{ id: 'demo', path: join(root, 'openspec'), valid: true }] } as any, store);
  metadata = new ProjectWorkspaceMetadata(resolver, store, new ProjectGit({ dataDir: join(dir, 'git-data') }));
});
afterEach(() => { vi.restoreAllMocks(); store.onApplicationShutdown(); delete process.env.DATA_DIR; });
function copy(id: string) {
  const work: Work = { id, sourceId: 'demo', projectPath: root, changeName: id, requestKey: id, ideaIds: [], phase: 'implementation', state: 'idle', threadId: null, reviewedVersion: null, createdAt: '', updatedAt: '' };
  store.save(work); new FileResults(store).prepare(work); return store.get(id)!;
}
it('비Git 복사 공간도 서버가 확인한 위치와 A/B baseline 겹침을 반환한다', async () => {
  const a = copy('a'), b = copy('b');
  writeFileSync(join(a.executionPath!, 'shared.txt'), 'A'); writeFileSync(join(b.executionPath!, 'shared.txt'), 'B');
  expect(await metadata.read('demo', a.id)).toMatchObject({ kind: 'copy', workId: 'a', executionPath: a.executionPath, overlaps: [{ workId: 'b', paths: ['shared.txt'] }], partial: true });
  expect(await metadata.read('demo')).toMatchObject({ kind: 'original', executionPath: root, overlaps: [], partial: true });
});
it('다른 업무가 없어도 비Git 원본을 변경 없음으로 표시하지 않는다', async () => {
  expect(await metadata.read('demo')).toMatchObject({ overlaps: [], partial: true });
  const a = copy('only');
  expect(await metadata.read('demo', a.id)).toMatchObject({ overlaps: [], partial: true });
});
it('겹침 조회에서 전체 결과 report를 만들지 않고 비동기 파일 비교 중 이벤트 루프를 양보한다', async () => {
  const a = copy('responsive-a'), b = copy('responsive-b');
  writeFileSync(join(a.executionPath!, 'shared.txt'), 'A'); writeFileSync(join(b.executionPath!, 'shared.txt'), 'B');
  const report = vi.spyOn(FileResults.prototype, 'report').mockImplementation(() => { throw new Error('Full reports must not be used'); });
  const quickGit = { status: async () => ({ available: false, branch: null, head: null, entries: [] }) } as unknown as ProjectGit;
  const quick = new ProjectWorkspaceMetadata(resolver, store, quickGit);
  let ticks = 0; const timer = setInterval(() => ticks++, 0);
  try {
    expect((await quick.read('demo', a.id)).overlaps).toEqual([{ workId: b.id, title: b.changeName, paths: ['shared.txt'] }]);
    expect(ticks).toBeGreaterThan(0); expect(report).not.toHaveBeenCalled();
  } finally { clearInterval(timer); }
});
it('요청 전체의 파일 비교 예산 초과는 부분 결과로 표시하고 작업 소스를 보존한다', async () => {
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test'); git(root, 'add', '--', 'shared.txt'); git(root, 'commit', '-m', 'base');
  const a = copy('limited-a'), b = copy('limited-b'); writeFileSync(join(a.executionPath!, 'shared.txt'), 'A'); writeFileSync(join(b.executionPath!, 'shared.txt'), 'B');
  const limited = new ProjectWorkspaceMetadata(resolver, store, new ProjectGit({ dataDir: join(dirname(root), 'limits') }), { maxEntries: 1 });
  expect(await limited.read('demo', a.id)).toMatchObject({ partial: true });
  expect(store.get(a.id)?.executionPath).toBe(a.executionPath);
});
it('읽기 바이트·시간 한도와 공유 링크는 불확실한 소스로 표시하고 파일을 따라 읽거나 변경하지 않는다', async () => {
  const a = copy('bounded'); writeFileSync(join(a.executionPath!, 'shared.txt'), 'changed');
  expect(await workspaceChangedPaths(a, a.executionPath!, store, new ChangeBudget({ maxBytes: 1 }))).toMatchObject({ partial: true });
  expect(await workspaceChangedPaths(a, a.executionPath!, store, new ChangeBudget({ timeoutMs: 0 }))).toMatchObject({ partial: true });
  linkSync(join(a.executionPath!, 'shared.txt'), join(a.executionPath!, 'linked.txt'));
  expect(await workspaceChangedPaths(a, a.executionPath!, store, new ChangeBudget())).toMatchObject({ partial: true });
  expect(readFileSync(join(a.executionPath!, 'shared.txt'), 'utf8')).toBe('changed');
});
it('업무의 커밋된 변경도 포함하며 소유 확인 실패는 빈 결과 대신 partial을 반환한다', async () => {
  const a = copy('a'), b = copy('b');
  git(a.executionPath!, 'init', '-b', 'main'); git(a.executionPath!, 'config', 'user.name', 'Fixture'); git(a.executionPath!, 'config', 'user.email', 'fixture@example.test');
  git(a.executionPath!, 'add', '--', 'shared.txt'); git(a.executionPath!, 'commit', '-m', 'base');
  writeFileSync(join(a.executionPath!, 'shared.txt'), 'committed A'); git(a.executionPath!, 'add', '--', 'shared.txt'); git(a.executionPath!, 'commit', '-m', 'A');
  writeFileSync(join(b.executionPath!, 'shared.txt'), 'B');
  expect((await metadata.read('demo', a.id)).overlaps).toEqual([{ workId: 'b', title: 'b', paths: ['shared.txt'] }]);
  b.executionPath = root; store.save(b);
  expect(await metadata.read('demo', a.id)).toMatchObject({ overlaps: [], partial: true });
  const foreign = { ...a, id: 'foreign', requestKey: 'foreign', sourceId: 'other' }; store.save(foreign);
  await expect(metadata.read('demo', foreign.id)).rejects.toThrow(/프로젝트/);
});
it('실제 등록된 Git A/B 공간의 baseline 이후 커밋 변경과 원본 미커밋 겹침을 구분한다', async () => {
  git(root, 'init', '-b', 'main'); git(root, 'config', 'core.longpaths', 'true'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
  git(root, 'add', '--', 'shared.txt'); git(root, 'commit', '-m', 'base');
  const head = git(root, 'rev-parse', 'HEAD'), profileId = randomUUID(), rootPath = join(dirname(root), 'r'); mkdirSync(rootPath);
  const registered = registerWorkspaceRoot(inspectWorkspacePath(rootPath, []), [], profileId);
  const create = (id: string) => {
    const workspaceId = randomUUID(), projectId = 'a'.repeat(64), container = join(registered.managedPath, 'projects', projectId, 'works', workspaceId), executionPath = join(container, 'project'); mkdirSync(container, { recursive: true });
    const branch = `codex/work-${id}`; git(root, 'worktree', 'add', '-b', branch, '--', executionPath.replaceAll('\\', '/'), head);
    const work: Work = { id, sourceId: 'demo', projectPath: root, changeName: id, requestKey: id, ideaIds: [], phase: 'implementation', state: 'idle', threadId: null, reviewedVersion: null, createdAt: '', updatedAt: '', executionPath,
      workspace: { version: 1, kind: 'git-worktree', status: 'ready', profileId, rootId: registered.rootId, rootPath, managedPath: registered.managedPath, projectId, workspaceId, executionPath, commonDir: join(root, '.git'), branch, baseCommit: head, workspaceBaselineCommit: head } };
    writeFileSync(join(container, 'identity.json'), JSON.stringify({ schemaVersion: 1, workId: id, projectPath: root, ...work.workspace })); store.save(work); return work;
  };
  const a = create('git-a'), b = create('git-b');
  writeFileSync(join(a.executionPath!, 'shared.txt'), 'A committed'); git(a.executionPath!, 'add', '--', 'shared.txt'); git(a.executionPath!, 'commit', '-m', 'A');
  writeFileSync(join(b.executionPath!, 'shared.txt'), 'B dirty');
  expect(await metadata.read('demo', a.id)).toMatchObject({ kind: 'git-worktree', baseCommit: head, workspaceBaselineCommit: head, branch: 'codex/work-git-a', partial: false, overlaps: [{ workId: b.id, paths: ['shared.txt'] }] });
  writeFileSync(join(root, 'shared.txt'), 'original dirty');
  expect((await metadata.read('demo', a.id)).overlaps).toEqual(expect.arrayContaining([expect.objectContaining({ workId: null, paths: ['shared.txt'] })]));
  expect((await metadata.read('demo')).overlaps.map(item => item.workId).sort()).toEqual([a.id, b.id]);
  const limited = new ProjectWorkspaceMetadata(resolver, store, new ProjectGit({ dataDir: join(dirname(root), 'git-limits') }), { maxEntries: 1 });
  expect(await limited.read('demo', a.id)).toMatchObject({ partial: true });
  b.phase = 'completed'; store.save(b);
  expect((await metadata.read('demo', a.id)).overlaps.some(item => item.workId === b.id)).toBe(false);
}, 30000);
