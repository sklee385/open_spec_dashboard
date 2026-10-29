import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/app';
import { WorkStore, type Work } from '../src/work/store';
import { WorkService } from '../src/work/work.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorktreeManager } from '../src/work/worktree-manager';
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let app: any, base: string, source: string, work: Work, store: WorkStore;
const saved = { CONFIG_PATH: process.env.CONFIG_PATH, DATA_DIR: process.env.DATA_DIR };
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-')); source = join(dir, 's'); mkdirSync(join(source, 'openspec'), { recursive: true }); mkdirSync(join(dir, 'c'));
  git(source, 'init', '-b', 'main'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test'); writeFileSync(join(source, 'code.txt'), 'original'); git(source, 'add', '--all'); git(source, 'commit', '-m', 'base');
  process.env.CONFIG_PATH = join(dir, 'c/config.json'); process.env.DATA_DIR = join(dir, 'd'); writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(source, 'openspec') }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl(); store = app.get(WorkStore);
  const settings = app.get(WorkspaceSettingsService), current = settings.read(), check = settings.check({ version: current.version, path: join(dir, 'r') }); settings.save({ version: current.version, token: check.token, confirmed: true });
  work = { id: 'a', sourceId: 'demo', projectPath: source, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'verification', state: 'idle', threadId: null, reviewedVersion: 'plan', createdAt: '', updatedAt: '' }; store.save(work);
  const head = git(source, 'rev-parse', 'HEAD'); await new WorktreeManager({ store }).create(work, settings, { requestKey: 'create', selectedBranch: 'main', baseCommit: head, sourceHead: head }); work.workspace!.status = 'ready'; work.workspace!.workspaceBaselineCommit = head; store.save(work);
});
afterEach(async () => { await app?.close(); vi.restoreAllMocks(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
const preview = async (query = '') => { const r = await fetch(`${base}/api/work/a/integration/reservation-preview${query}`); return { status: r.status, data: await r.json() }; };
it('readonly 예약 미리보기는 실제소유 HEAD/local branches를 제공하고 검증·예약·index를 바꾸지 않는다', async () => {
  const head = git(source, 'rev-parse', 'HEAD'); git(source, 'branch', 'target', head); git(source, 'update-ref', 'refs/remotes/origin/remote', head);
  const before = [source, work.executionPath!].map(root => git(root, 'rev-parse', 'HEAD') + git(root, 'ls-files', '--stage')), readiness = vi.spyOn(app.get(WorkService), 'integrationReadiness');
  const response = await preview(); expect(response.status).toBe(200); expect(response.data).toEqual({ workHead: head, sourceHead: head, sourceBranch: 'main', reviewedVersion: 'plan', branches: [{ name: 'main', commit: head }, { name: 'target', commit: head }] });
  expect(readiness).not.toHaveBeenCalled(); expect(store.integrationRequests()).toEqual([]); expect([source, work.executionPath!].map(root => git(root, 'rev-parse', 'HEAD') + git(root, 'ls-files', '--stage'))).toEqual(before);
  git(source, 'checkout', '--detach', head); expect((await preview()).data.sourceBranch).toBeNull(); expect((await preview('?path=other&command=reset')).status).toBe(400);
});
it('readonly 예약 미리보기는 업무 pointer/원본 source 관계 변조를 거부한다', async () => {
  store.save({ ...work, sourceId: 'foreign' }); expect((await preview()).status).toBe(404); store.save(work);
  const path = join(work.executionPath!, '.git'), pointer = readFileSync(path, 'utf8'), fd = openSync(path, 'r+'); try { ftruncateSync(fd); writeFileSync(fd, pointer.replace(/gitdir:/, 'foreign:')); } finally { closeSync(fd); }
  expect((await preview()).status).toBe(409);
});
