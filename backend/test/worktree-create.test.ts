import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { WorktreeManager } from '../src/work/worktree-manager';
import { WorkStore, type Work } from '../src/work/store';
import { LegacyService } from '../src/legacy/legacy.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { runGit } from '../src/projects/git-runner';
vi.setConfig({ testTimeout: 30000 });
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const addsWorktree = (args: string[]) => args.includes('worktree') && args[args.indexOf('worktree') + 1] === 'add';
let dir: string, source: string, legacy: LegacyService, store: WorkStore, settings: WorkspaceSettingsService, work: Work, request: any;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'g-')); source = join(dir, 's'); mkdirSync(source); git(source, 'init', '-b', 'main'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test'); git(source, 'config', 'core.longpaths', 'true');
  writeFileSync(join(source, 'code.txt'), 'base'); git(source, 'add', '--', 'code.txt'); git(source, 'commit', '-m', 'base');
  process.env.CONFIG_PATH = join(dir, 'config.json'); process.env.DATA_DIR = join(dir, 'data'); delete process.env.WORKSPACE_ROOT;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [] })); legacy = new LegacyService(); store = new WorkStore(); settings = new WorkspaceSettingsService(legacy, store);
  vi.spyOn(settings, 'protectedPaths').mockReturnValue([source, process.env.DATA_DIR]);
  const initial = settings.read(), check = settings.check({ version: initial.version, path: join(dir, 'r') }); settings.save({ version: initial.version, token: check.token, confirmed: true });
  work = { id: 'a', sourceId: 'demo', projectPath: source, changeName: 'feature', requestKey: 'a', ideaIds: [], phase: 'reviewed', state: 'idle', threadId: 'same-thread', reviewedVersion: 'plan', createdAt: '', updatedAt: '' }; store.save(work);
  const head = git(source, 'rev-parse', 'HEAD'); request = { requestKey: 'create-a', selectedBranch: 'main', baseCommit: head, sourceHead: head };
});
afterEach(async () => { await legacy.onModuleDestroy(); store.onApplicationShutdown(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; });
it('의도 저장 후 실제 고유 브랜치와 worktree를 만들고 같은 요청을 재조회한다', async () => {
  const manager = new WorktreeManager({ store }); let persistedBeforeGit = false;
  const checked = new WorktreeManager({ store, run: async (root, args) => { if (addsWorktree(args)) persistedBeforeGit = store.records(work.id, 'workspace-creation').length === 1; return runGit(root, args); } });
  const created = await checked.create(work, settings, request); expect(persistedBeforeGit).toBe(true);
  expect(created.status).toBe('created'); expect(work.workspace).toMatchObject({ kind: 'git-worktree', branch: 'codex/work-a', status: 'preparing' });
  expect(git(work.executionPath!, 'rev-parse', 'HEAD')).toBe(request.baseCommit); expect(git(source, 'rev-parse', 'HEAD')).toBe(request.sourceHead);
  expect(git(source, 'worktree', 'list', '--porcelain')).toContain(work.executionPath!.replaceAll('\\', '/'));
  expect(store.get(work.id)?.threadId).toBe('same-thread');
  const again = await manager.create(store.get(work.id)!, settings, request); expect(again).toEqual(created);
  expect(store.records(work.id, 'workspace-creation')).toHaveLength(1);
  await expect(manager.create(work, settings, { ...request, requestKey: 'different' })).rejects.toThrow(/요청|공간/);
});
it('기존 브랜치를 거부하고 준비 중 기준 변경을 검출한다', async () => {
  git(source, 'branch', 'codex/work-a'); const manager = new WorktreeManager({ store });
  await expect(manager.create(work, settings, request)).rejects.toThrow(/브랜치/);
  expect(store.get(work.id)?.executionPath).toBeUndefined(); expect(git(source, 'rev-parse', 'codex/work-a')).toBe(request.baseCommit);
  await expect(manager.create(work, settings, { ...request, baseCommit: '0'.repeat(40) })).rejects.toThrow(/기준/);
});
it('Git 성공 후 응답 유실은 실제 등록과 소유를 확인해 복구하고 새 공간을 생성하지 않는다', async () => {
  let fail = true;
  const manager = new WorktreeManager({ store, run: async (root, args) => { const result = await runGit(root, args); if (fail && addsWorktree(args)) { fail = false; throw new Error('response lost'); } return result; } });
  await expect(manager.create(work, settings, request)).rejects.toThrow(/response lost/);
  const saved = store.get(work.id)!; expect(saved.workspace?.status).toBe('recovery-required'); expect(existsSync(saved.executionPath!)).toBe(true);
  const recovered = await manager.create(saved, settings, request); expect(recovered.status).toBe('created'); expect(store.get(work.id)?.executionPath).toBe(saved.executionPath);
  expect(store.get(work.id)?.threadId).toBe('same-thread');
});
it('식별 파일 변조나 중간 생성 실패는 자동 copy·새 경로·삭제로 복구하지 않는다', async () => {
  const manager = new WorktreeManager({ store }); await manager.create(work, settings, request);
  const identity = join(work.executionPath!, '..', 'identity.json'); writeFileSync(identity, readFileSync(identity, 'utf8').replace('"workId":"a"', '"workId":"foreign"'));
  await expect(manager.create(store.get(work.id)!, settings, request)).rejects.toThrow(/복구|소유/);
  expect(existsSync(work.executionPath!)).toBe(true);
});
it('Git 생성 전 장애의 잔여와 요청을 보존하고 재조회가 새 경로를 만들지 않는다', async () => {
  let additions = 0;
  const manager = new WorktreeManager({ store, run: async (root, args) => { if (addsWorktree(args)) { additions++; throw new Error('injected interruption'); } return runGit(root, args); } });
  await expect(manager.create(work, settings, request)).rejects.toThrow(/injected/);
  const saved = store.get(work.id)!, path = saved.executionPath!;
  expect(existsSync(join(path, '..', 'identity.json'))).toBe(true);
  await expect(manager.create(saved, settings, request)).rejects.toThrow(/복구/);
  expect(additions).toBe(1); expect(store.get(work.id)?.executionPath).toBe(path); expect(store.get(work.id)?.threadId).toBe('same-thread');
});
it('연결 중인 같은 요청은 생성 하나를 공유하고 다른 요청은 즉시 거부한다', async () => {
  let release!: () => void, entered!: () => void, additions = 0;
  const reached = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  const firstManager = new WorktreeManager({ store, run: async (root, args) => { if (addsWorktree(args)) { additions++; entered(); await hold; } return runGit(root, args); } });
  const first = firstManager.create(work, settings, request); await reached;
  const second = new WorktreeManager({ store }).create(store.get(work.id)!, settings, request);
  try { await expect(new WorktreeManager({ store }).create(store.get(work.id)!, settings, { ...request, requestKey: 'other' })).rejects.toThrow(/요청/); }
  finally { release(); }
  const [a, b] = await Promise.all([first, second]); expect(a).toEqual(b); expect(additions).toBe(1);
});
it('worktree 생성에서 원본 저장소의 checkout hook을 자동 실행하지 않는다', async () => {
  const hook = join(source, '.git', 'hooks', 'post-checkout'); writeFileSync(hook, '#!/bin/sh\nprintf leaked > hook-ran.txt\n'); chmodSync(hook, 0o755);
  await new WorktreeManager({ store }).create(work, settings, request);
  expect(existsSync(join(work.executionPath!, 'hook-ran.txt'))).toBe(false); expect(existsSync(join(source, 'hook-ran.txt'))).toBe(false);
});
it('생성 중 선택 브랜치 tip이 바뀌면 원본 HEAD가 같아도 중단하고 복구 재확인을 요구한다', async () => {
  git(source, 'branch', 'feature'); request.selectedBranch = 'feature';
  const next = git(source, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'new feature tip');
  const manager = new WorktreeManager({ store, run: async (root, args) => { const result = await runGit(root, args); if (addsWorktree(args)) git(source, 'update-ref', 'refs/heads/feature', next); return result; } });
  await expect(manager.create(work, settings, request)).rejects.toThrow(/기준/);
  expect(git(source, 'rev-parse', 'HEAD')).toBe(request.sourceHead);
  expect(store.get(work.id)?.workspace?.status).toBe('recovery-required');
  await expect(manager.create(store.get(work.id)!, settings, request)).rejects.toThrow(/복구/);
});
