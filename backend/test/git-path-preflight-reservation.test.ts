import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { LegacyService } from '../src/legacy/legacy.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorkStore, type Work } from '../src/work/store';
import { WorktreeManager } from '../src/work/worktree-manager';
import { WorkspaceService } from '../src/work/workspace.service';
import * as gitPathPreflight from '../src/work/git-path-preflight';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});
vi.setConfig({ testTimeout: 30000 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const environment = { CONFIG_PATH: process.env.CONFIG_PATH, DATA_DIR: process.env.DATA_DIR, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
let dir: string, source: string, legacy: LegacyService, store: WorkStore, settings: WorkspaceSettingsService, work: Work;
function selectRoot(path: string) {
  const initial = settings.read(), check = settings.check({ version: initial.version, path });
  return settings.save({ version: initial.version, token: check.token, confirmed: true });
}
function assertUnreserved() {
  expect(work.workspace).toBeUndefined(); expect(work.executionPath).toBeUndefined();
  expect(store.get(work.id)?.workspace).toBeUndefined(); expect(store.get(work.id)?.executionPath).toBeUndefined();
  for (const kind of ['workspace-creation', 'workspace-preparation', 'workspace-git-intent']) expect(store.records(work.id, kind)).toEqual([]);
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gp-')); source = join(dir, 's'); mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture');
  process.env.CONFIG_PATH = join(dir, 'config.json'); process.env.DATA_DIR = join(dir, 'data'); delete process.env.WORKSPACE_ROOT;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [] })); legacy = new LegacyService(); store = new WorkStore(); settings = new WorkspaceSettingsService(legacy, store);
  vi.spyOn(settings, 'protectedPaths').mockReturnValue([source, process.env.DATA_DIR]);
  work = { id: 'path-check', sourceId: 'demo', projectPath: source, changeName: 'feature', requestKey: 'path-check', ideaIds: [], phase: 'reviewed', state: 'idle', threadId: 'same-thread', reviewedVersion: 'plan', createdAt: '', updatedAt: '' }; store.save(work);
});
afterEach(async () => {
  await legacy?.onModuleDestroy(); store?.onApplicationShutdown(); vi.mocked(childProcess.execFileSync).mockReset(); vi.restoreAllMocks();
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (dir) {
    const owned = resolve(dir);
    if (dirname(owned) !== resolve(tmpdir()) || !basename(owned).startsWith('gp-')) throw new Error('fixture cleanup boundary');
    rmSync(owned, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== 'win32')('실제 Git의 긴 예정 경로를 예약 전에 차단하고 짧은 루트로 같은 업무를 재시도한다', async () => {
  const selected = selectRoot(join(dir, 'long-' + 'x'.repeat(25)));
  const projectId = createHash('sha256').update(realpathSync(source)).digest('hex');
  const future = join(selected.managedPath!, 'projects', projectId, 'works', '00000000-0000-0000-0000-000000000000', 'project');
  let actualError = '';
  try { git(source, '-c', 'core.longpaths=true', 'worktree', 'add', '--detach', '--', future, 'HEAD'); }
  catch (error: any) { actualError = error.stderr.toString(); }
  expect(actualError).toContain("'$GIT_DIR' too big");
  const head = git(source, 'rev-parse', 'HEAD'), listing = git(source, 'worktree', 'list', '--porcelain');
  const request = { requestKey: 'create-path', selectedBranch: 'main', baseCommit: head, sourceHead: head };
  const manager = new WorktreeManager({ store });
  let rejected: unknown;
  try { await manager.create(work, settings, request); } catch (error) { rejected = error; }
  assertUnreserved();
  expect(rejected).toMatchObject({ message: expect.stringMatching(/짧은.*루트/) });
  expect(git(source, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(source, 'worktree', 'list', '--porcelain')).toBe(listing);
  expect(git(source, 'branch', '--list', 'codex/work-path-check')).toBe('');
  selectRoot(join(dir, 'r'));
  const created = await manager.create(work, settings, request);
  expect(created.status).toBe('created'); expect(store.get(work.id)?.threadId).toBe('same-thread');
  expect(git(work.executionPath!, 'rev-parse', 'HEAD')).toBe(head); expect(existsSync(work.executionPath!)).toBe(true);
  selectRoot(join(dir, 'long-' + 'x'.repeat(25)));
  const probe = vi.spyOn(gitPathPreflight, 'preflightGitDirectoryPath').mockImplementation(() => { throw new Error('existing workspace must not be probed again'); });
  expect(await manager.create(store.get(work.id)!, settings, request)).toEqual(created);
  expect(probe).not.toHaveBeenCalled();
});
it('예상하지 못한 사전 점검 실패도 예약과 모든 생성 기록 전에 중단한다', () => {
  const selected = selectRoot(join(dir, 'r'));
  vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' }); });
  expect(() => new WorkspaceService(store).reserve(work, settings, 'git-worktree')).toThrow(/점검 결과/);
  assertUnreserved(); expect(existsSync(join(selected.managedPath!, 'projects'))).toBe(false);
});
it('명시적인 copy 공간은 Git 경로 검사를 요구하지 않는다', () => {
  selectRoot(join(dir, 'r'));
  const probe = vi.spyOn(gitPathPreflight, 'preflightGitDirectoryPath').mockImplementation(() => { throw new Error('Git unavailable'); });
  expect(new WorkspaceService(store).reserve(work, settings, 'copy').kind).toBe('copy');
  expect(probe).not.toHaveBeenCalled();
});
