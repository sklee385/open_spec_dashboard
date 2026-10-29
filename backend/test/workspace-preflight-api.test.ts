import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/app';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorkStore } from '../src/work/store';

vi.setConfig({ testTimeout: 60000 });
let app: any, base: string, root: string, source: string, work: any, settings: WorkspaceSettingsService;
const environment = { CONFIG_PATH: process.env.CONFIG_PATH, DATA_DIR: process.env.DATA_DIR, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT, OPENSPEC_WORKTREE_EXPERIMENTAL: process.env.OPENSPEC_WORKTREE_EXPERIMENTAL };
const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const request = async (path: string, body?: any) => {
  const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
};
function selectRoot(path: string) {
  const initial = settings.read(), checked = settings.check({ version: initial.version, path });
  return settings.save({ version: initial.version, token: checked.token, confirmed: true });
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pw-')); source = join(root, 's');
  const documents = join(source, 'openspec/changes/feature'); mkdirSync(join(documents, 'specs/feature'), { recursive: true });
  for (const name of ['proposal.md', 'design.md', 'tasks.md', 'specs/feature/spec.md']) writeFileSync(join(documents, name), '# Plan\n');
  git('init', '-b', 'main'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); git('add', '--', 'openspec'); git('commit', '-m', 'fixture');
  mkdirSync(join(root, 'c')); process.env.CONFIG_PATH = join(root, 'c/config.json'); process.env.DATA_DIR = join(root, 'data'); process.env.OPENSPEC_WORKTREE_EXPERIMENTAL = '1'; delete process.env.WORKSPACE_ROOT;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(source, 'openspec') }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl(); settings = app.get(WorkspaceSettingsService);
  selectRoot(join(root, 'r'));
  work = (await request('work', { sourceId: 'demo', changeName: 'feature', requestKey: 'feature' })).data;
  expect((await request(`work/${work.id}/action`, { action: 'review' })).status).toBe(200);
});
afterEach(async () => {
  await app?.close(); vi.restoreAllMocks();
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

it.skipIf(process.platform !== 'win32').each(['same', 'new'])('실제 HTTP 긴 Git 경로 실패는 생성 의도를 남기지 않고 짧은 루트의 %s 요청 키로 같은 업무를 준비한다', async mode => {
  const endpoint = `work/${work.id}/workspace`, preview = (await request(`${endpoint}/preview?selectedBranch=main`)).data;
  const body = { requestKey: 'prepare-path', selectedBranch: 'main', previewToken: preview.documents.confirmationToken, excludedConfirmed: true,
    policy: { version: 1, projectId: preview.projectId, planRevision: preview.documents.planRevision, confirmed: true, runtime: 'none', dependencies: 'none', paths: [], generatedPaths: [], commands: [] } };
  const selected = selectRoot(join(root, 'long-' + 'x'.repeat(50))), before = app.get(WorkStore).get(work.id);
  const head = git('rev-parse', 'HEAD'), listing = git('worktree', 'list', '--porcelain');
  const rejected = await request(`${endpoint}/prepare`, body);
  expect(rejected).toMatchObject({ status: 409, data: { errorCode: 'workspace-git-path-unsupported', mutationOutcome: 'rejected-before-intent', requestKey: body.requestKey } });
  const store = app.get(WorkStore), failed = store.get(work.id);
  expect(failed.workspace).toBeUndefined(); expect(failed.executionPath).toBeUndefined();
  expect(failed.state).toBe(before.state); expect(failed.errorCode).toBeUndefined();
  for (const kind of ['workspace-request', 'workspace-creation', 'workspace-preparation', 'workspace-git-intent', 'workspace-baseline', 'isolated-baseline']) expect(store.records(work.id, kind)).toEqual([]);
  expect(existsSync(join(selected.managedPath!, 'projects'))).toBe(false);
  expect(git('rev-parse', 'HEAD')).toBe(head); expect(git('worktree', 'list', '--porcelain')).toBe(listing); expect(git('branch', '--list', `codex/work-${work.id}`)).toBe('');
  selectRoot(join(root, 'r'));
  const renewed = (await request(`${endpoint}/preview?selectedBranch=main`)).data;
  const ready = await request(`${endpoint}/prepare`, { ...body, requestKey: mode === 'same' ? body.requestKey : 'prepare-path-new', previewToken: renewed.documents.confirmationToken });
  expect(ready).toMatchObject({ status: 200, data: { kind: 'git-worktree', status: 'ready' } });
  expect(store.get(work.id).threadId).toBe(before.threadId);
});
