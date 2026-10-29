import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { WorkStore, type Work } from '../src/work/store';
import { LegacyService } from '../src/legacy/legacy.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorkspaceProvisioner } from '../src/work/workspace-provisioner';
import { WorktreeManager } from '../src/work/worktree-manager';
import { FileResults } from '../src/work/file-results';
import { WorkspaceService } from '../src/work/workspace.service';
import { GitError, runGit } from '../src/projects/git-runner';
import { projectCoordinator } from '../src/projects/coordinator';
vi.setConfig({ testTimeout: 45000 });
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const replacePointer = (path: string, content: string) => { const file = openSync(path, 'r+'); try { ftruncateSync(file); writeFileSync(file, content); } finally { closeSync(file); } };
let dir: string, source: string, store: WorkStore, legacy: LegacyService, settings: WorkspaceSettingsService, work: Work, provisioner: WorkspaceProvisioner;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'p-')); source = join(dir, 's');
  const change = join(source, 'openspec/changes/feature'); mkdirSync(join(change, 'specs/feature'), { recursive: true });
  for (const name of ['proposal.md', 'design.md', 'tasks.md', 'specs/feature/spec.md']) writeFileSync(join(change, name), '# reviewed\n');
  writeFileSync(join(source, 'code.txt'), 'base');
  mkdirSync(join(dir, 'config')); process.env.DATA_DIR = join(dir, 'data'); process.env.CONFIG_PATH = join(dir, 'config/config.json'); delete process.env.WORKSPACE_ROOT;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [] })); store = new WorkStore(); legacy = new LegacyService(); settings = new WorkspaceSettingsService(legacy, store);
  vi.spyOn(settings, 'protectedPaths').mockReturnValue([source, process.env.DATA_DIR]);
  const initial = settings.read(), check = settings.check({ version: initial.version, path: join(dir, 'r') }); settings.save({ version: initial.version, token: check.token, confirmed: true });
  work = { id: 'a', sourceId: 'source', projectPath: source, changeName: 'feature', requestKey: 'a', ideaIds: [], phase: 'reviewed', state: 'idle', threadId: 'same-thread', reviewedVersion: 'reviewed', createdAt: '', updatedAt: '' }; store.save(work);
  provisioner = new WorkspaceProvisioner(store, settings, { enabled: () => true });
});
afterEach(async () => { await provisioner.close(); await legacy.onModuleDestroy(); store.onApplicationShutdown(); delete process.env.DATA_DIR; delete process.env.CONFIG_PATH; });
function repository() { git(source, 'init', '-b', 'main'); git(source, 'config', 'core.autocrlf', 'false'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test'); git(source, 'add', '--', 'code.txt', 'openspec'); git(source, 'commit', '-m', 'base'); }
it('명시적 확인으로 Git 문서·로컬 준비를 끝내고 같은 공간을 동기 검증하여 재사용한다', async () => {
  repository(); writeFileSync(join(source, '.env'), 'TOKEN=local-only');
  const manager = (provisioner as any).manager as WorktreeManager, local = manager.prepareLocal.bind(manager);
  vi.spyOn(manager, 'prepareLocal').mockImplementation(async (...args) => {
    const coordinator = projectCoordinator(store);
    expect(() => coordinator.acquireOperation({ kind: 'management', root: source })()).not.toThrow();
    expect(() => coordinator.acquireOperation({ kind: 'index', root: args[0].executionPath! })).toThrow();
    expect(() => coordinator.acquireOperation({ kind: 'documents', root: source, changeName: work.changeName })).toThrow();
    return local(...args);
  });
  const preview = await provisioner.preview(work, 'main');
  const request = { requestKey: 'prepare-a', previewToken: preview.documents!.confirmationToken, excludedConfirmed: true, policy: { version: 1, projectId: preview.projectId, planRevision: preview.documents!.planRevision, confirmed: true, runtime: 'none', dependencies: 'none', paths: ['.env'], generatedPaths: [], commands: [] } };
  const ready = await provisioner.prepare(work, request); expect(ready.status).toBe('ready'); expect(ready.kind).toBe('git-worktree');
  const fresh = store.get(work.id)!; expect(new FileResults(store).path(fresh)).toBe(fresh.executionPath);
  expect(() => new FileResults(store).prepare(fresh)).not.toThrow();
  expect(git(fresh.executionPath!, 'ls-files', '--', '.env')).toBe(''); expect(fresh.threadId).toBe('same-thread');
  const head = git(fresh.executionPath!, 'rev-parse', 'HEAD'); expect(await provisioner.prepare(fresh, request)).toMatchObject({ workspaceId: fresh.workspace!.workspaceId }); expect(git(fresh.executionPath!, 'rev-parse', 'HEAD')).toBe(head);
  expect(() => new FileResults(store).apply(fresh)).toThrow(/통합/);
  const pointer = join(fresh.executionPath!, '.git'), original = readFileSync(pointer, 'utf8'), impostor = join(dir, 'impostor');
  git(source, 'worktree', 'add', '--force', impostor, fresh.workspace!.branch!); replacePointer(pointer, readFileSync(join(impostor, '.git'), 'utf8'));
  expect(() => new WorkspaceService(store).path(fresh)).toThrow(/복구/);
  await expect(new WorktreeManager({ store }).verify(fresh, settings)).rejects.toThrow(/소유|포인터|경계/);
  replacePointer(pointer, original);
  git(fresh.executionPath!, 'checkout', '--detach'); expect(() => new WorkspaceService(store).path(fresh)).toThrow(/복구/);
});
it('실제 비Git 새 업무는 고정 copy 공간으로 준비하며 원본 반영·완료를 별도로 유지한다', async () => {
  writeFileSync(join(source, '.env'), 'TOKEN=never-copy'); mkdirSync(join(source, '.data')); writeFileSync(join(source, '.data/live.sqlite'), 'operation');
  for (const name of ['.aws', '.codex', '.reference']) { mkdirSync(join(source, name)); writeFileSync(join(source, name, 'private.json'), 'fixture-private-credentials'); }
  expect((await provisioner.preview(work)).git.state).toBe('not-git');
  await provisioner.prepare(work, { requestKey: 'copy-a', confirmed: true });
  const fresh = store.get(work.id)!, files = new FileResults(store);
  expect(fresh.workspace).toMatchObject({ kind: 'copy', status: 'ready' }); expect(files.path(fresh)).toBe(fresh.executionPath);
  expect(existsSync(join(fresh.executionPath!, '.env'))).toBe(false); expect(existsSync(join(fresh.executionPath!, '.data'))).toBe(false);
  for (const name of ['.aws', '.codex', '.reference']) expect(existsSync(join(fresh.executionPath!, name))).toBe(false);
  expect(JSON.stringify(store.records(work.id, 'isolated-baseline'))).not.toContain('fixture-private-credentials');
  writeFileSync(join(fresh.executionPath!, 'code.txt'), 'result'); expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('base'); expect(() => files.freeze(fresh)).toThrow(/반영/);
  files.apply(fresh); files.freeze(fresh); expect(store.get(work.id)?.phase).toBe('completed'); expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('result'); expect(fresh.threadId).toBe('same-thread');
});
it('HEAD 없는 Git만 copy를 허용하고 원본 저장소를 수정하지 않는다', async () => {
  git(source, 'init', '-b', 'main'); const preview = await provisioner.preview(work); expect(preview.git.state).toBe('no-commits');
  await provisioner.prepare(work, { requestKey: 'unborn-a', confirmed: true }); expect(store.get(work.id)?.workspace?.kind).toBe('copy'); expect(git(source, 'status', '--porcelain')).toContain('??');
  expect(existsSync(join(work.executionPath!, '.git'))).toBe(false);
});
it('Git 실행 오류는 copy 생성이나 원본 대체로 바꾸지 않는다', async () => {
  const broken = new WorkspaceProvisioner(store, settings, { enabled: () => true, manager: new WorktreeManager({ store, run: async () => { throw new GitError('fixture unavailable', 503); } }) });
  await expect(broken.prepare(work, { requestKey: 'bad', confirmed: true })).rejects.toThrow(/unavailable/);
  expect(store.get(work.id)?.executionPath).toBeUndefined(); expect(store.records(work.id, 'isolated-baseline')).toHaveLength(0);
});
it('신규 기본값은 비활성이고 기존 copy 업무 재개는 경로·대화·기준을 그대로 쓴다', async () => {
  const disabled = new WorkspaceProvisioner(store, settings, { enabled: () => false });
  await expect(disabled.prepare(work, { requestKey: 'new', confirmed: true })).rejects.toThrow(/활성|준비/);
  new FileResults(store).prepare(work); const before = store.get(work.id)!;
  expect(await disabled.prepare(before, {})).toMatchObject({ kind: 'copy', legacy: true, executionPath: before.executionPath });
  expect(store.get(work.id)?.executionPath).toBe(before.executionPath); expect(store.get(work.id)?.threadId).toBe('same-thread'); expect(dirname(before.executionPath!)).not.toBe(source);
});
it('Git 생성 응답 유실은 동일 고정 공간의 실제 상태로만 복구하고 copy를 만들지 않는다', async () => {
  repository(); const preview = await provisioner.preview(work, 'main');
  const body = { requestKey: 'lost-a', previewToken: preview.documents!.confirmationToken, excludedConfirmed: true, policy: { version: 1, projectId: preview.projectId, planRevision: preview.documents!.planRevision, confirmed: true, runtime: 'none', dependencies: 'none', paths: [], generatedPaths: [], commands: [] } };
  let lost = false;
  const losing = new WorkspaceProvisioner(store, settings, { enabled: () => true, manager: new WorktreeManager({ store, run: async (root, args) => { const value = await runGit(root, args); if (!lost && args.includes('add') && args.includes('worktree')) { lost = true; throw new Error('creation response lost'); } return value; } }) });
  await expect(losing.prepare(work, body)).rejects.toThrow(/response lost/);
  const failed = store.get(work.id)!, path = failed.executionPath; expect(failed.workspace?.kind).toBe('git-worktree'); expect(failed.workspace?.status).toBe('recovery-required'); expect(existsSync(path!)).toBe(true); expect(store.records(work.id, 'isolated-baseline')).toHaveLength(0);
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600000);
  try {
    await expect(provisioner.prepare(failed, body)).rejects.toThrow(/확인|최신/);
    const renewed = await provisioner.preview(store.get(work.id)!, 'main'); expect(renewed.documents).toBeTruthy();
    expect(await provisioner.prepare(store.get(work.id)!, { ...body, previewToken: renewed.documents!.confirmationToken })).toMatchObject({ kind: 'git-worktree', status: 'ready', executionPath: path });
  } finally { now.mockRestore(); }
  expect(git(source, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2); expect(store.get(work.id)?.threadId).toBe('same-thread');
});
it('생성 Git 프로세스 종료 미확인은 실패 뒤에도 관리·대상 ref 범위를 차단한다', async () => {
  repository(); const preview = await provisioner.preview(work, 'main');
  const broken = new WorkspaceProvisioner(store, settings, { enabled: () => true, manager: new WorktreeManager({ store, run: async (root, args) => {
    if (args.includes('worktree') && args.includes('add')) throw new GitError('termination unknown', 409, true, true);
    return runGit(root, args);
  } }) });
  await expect(broken.prepare(work, { requestKey: 'unknown-a', previewToken: preview.documents!.confirmationToken, excludedConfirmed: true, policy: { version: 1, projectId: preview.projectId, planRevision: preview.documents!.planRevision, confirmed: true, runtime: 'none', dependencies: 'none', paths: [], generatedPaths: [], commands: [] } })).rejects.toThrow(/termination unknown/);
  expect(store.records(work.id, 'workspace-git-intent')[0]).toMatchObject({ status: 'uncertain', scope: 'management', terminationUnconfirmed: true });
  expect(() => projectCoordinator(store).acquireOperation({ kind: 'management', root: source })).toThrow(/미확인/);
  expect(() => projectCoordinator(store).acquireOperation({ kind: 'index', root: source })).toThrow(/미확인/);
  const independent = join(dir, 'independent'); mkdirSync(independent);
  expect(() => projectCoordinator(store).acquireOperation({ kind: 'workspace', root: independent })()).not.toThrow();
});
