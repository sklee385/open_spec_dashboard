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
import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as pathChecks from '../src/work/git-path-preflight';
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
it.each(['same', 'new'])('예약 전 typed 경로 오류만 남은 Git 업무는 %s 키로 재시도하고 실패 이력을 보존한다', async mode => {
  repository(); const preview = await provisioner.preview(work, 'main');
  const body = { requestKey: 'path-retry', selectedBranch: 'main', previewToken: preview.documents!.confirmationToken, excludedConfirmed: true, policy: { version: 1, projectId: preview.projectId, planRevision: preview.documents!.planRevision, confirmed: true, runtime: 'none', dependencies: 'none', paths: [], generatedPaths: [], commands: [] } };
  const manager = (provisioner as any).manager as WorktreeManager;
  const fail = vi.spyOn(manager, 'create').mockRejectedValueOnce(new ConflictException({ message: 'late preflight', errorCode: 'workspace-git-path-check-failed' }));
  await expect(provisioner.prepare(work, body)).rejects.toThrow('late preflight'); fail.mockRestore();
  expect(store.get(work.id)?.workspace).toBeUndefined(); expect(store.records(work.id, 'workspace-request')[0]).toMatchObject({ status: 'failed', errorCode: 'workspace-git-path-check-failed' });
  if (mode === 'same') await expect(provisioner.prepare(work, { ...body, selectedBranch: 'other' })).rejects.toThrow(/기존 생성 요청/);
  const renewed = await provisioner.preview(work, 'main');
  const ready = await provisioner.prepare(work, { ...body, requestKey: mode === 'same' ? body.requestKey : 'fresh-path-retry', previewToken: renewed.documents!.confirmationToken });
  expect(ready).toMatchObject({ kind: 'git-worktree', status: 'ready' });
  expect(store.records(work.id, 'workspace-request-history')).toHaveLength(1);
  expect(store.records(work.id, 'workspace-request-history')[0]).toMatchObject({ requestKey: body.requestKey, status: 'failed', errorCode: 'workspace-git-path-check-failed' });
});
it.each(['baseline', 'isolated-baseline', 'workspace-creation', 'workspace-documents', 'workspace-preparation', 'workspace-git-intent', 'workspace-local-preparation', 'workspace-local-process', 'workspace-baseline'])('typed 경로 실패여도 %s 흔적이 있으면 새 공간 재시도를 차단한다', async kind => {
  repository(); store.record('old-request', work.id, 'workspace-request', { requestKey: 'old', kind: 'git-worktree', status: 'failed', errorCode: 'workspace-git-path-unsupported' });
  store.record('residue', work.id, kind, { status: 'failed' });
  await expect(provisioner.prepare(work, { requestKey: 'new' })).rejects.toThrow();
  expect(store.records(work.id, 'workspace-request-history')).toHaveLength(0); expect(store.get(work.id)?.workspace).toBeUndefined();
});
it.each([{ kind: 'git-worktree', status: 'failed' }, { kind: 'copy', status: 'failed', errorCode: 'workspace-git-path-unsupported' }, { kind: 'git-worktree', status: 'uncertain', errorCode: 'workspace-git-path-unsupported' }])('legacy·copy·uncertain 요청은 자동 재시도하지 않는다: %j', async previous => {
  repository(); store.record('old-request', work.id, 'workspace-request', { requestKey: 'old', ...previous });
  await expect(provisioner.prepare(work, { requestKey: 'new' })).rejects.toThrow(); expect(store.records(work.id, 'workspace-request-history')).toHaveLength(0);
});
it('동일 키의 uncertain 요청도 workspace가 없다는 이유로 재실행하지 않는다', async () => {
  repository(); const body = { requestKey: 'unknown' }, fingerprint = createHash('sha256').update(JSON.stringify({ ...body, previewToken: undefined })).digest('hex');
  store.record('old-request', work.id, 'workspace-request', { ...body, fingerprint, kind: 'git-worktree', status: 'uncertain', errorCode: 'workspace-git-path-unsupported' });
  await expect(provisioner.prepare(work, body)).rejects.toThrow(/실제 종료/); expect(store.records(work.id, 'workspace-request-history')).toHaveLength(0);
});
it('예약 사전검사는 settings 쓰기 잠금·업무 저장·생성 기록 없이 같은 계획을 검사한다', () => {
  const spaces = new WorkspaceService(store), before = store.get(work.id), config = readFileSync(process.env.CONFIG_PATH!, 'utf8');
  const lock = vi.spyOn(settings, 'withSelectedRoot');
  const plan = spaces.preflightReservation(work, settings, 'copy');
  expect(plan).toMatchObject({ kind: 'copy', status: 'preparing' }); expect(lock).not.toHaveBeenCalled();
  expect(store.get(work.id)).toEqual(before); expect(readFileSync(process.env.CONFIG_PATH!, 'utf8')).toBe(config); expect(existsSync(plan.executionPath)).toBe(false);
  expect(store.records(work.id, 'workspace-creation')).toHaveLength(0);
  const actual = spaces.reserve(work, settings, 'copy'); expect(lock).toHaveBeenCalledOnce(); expect(actual.rootId).toBe(plan.rootId); expect(actual.executionPath.length).toBe(plan.executionPath.length);
});
it('실제 Git 예약은 readonly 검사 뒤에도 경로를 재확인하고 실패 시 공간을 저장하지 않는다', () => {
  const spaces = new WorkspaceService(store), before = store.get(work.id);
  const check = vi.spyOn(pathChecks, 'preflightGitDirectoryPath').mockReturnValueOnce({ state: 'git-directory-absent' }).mockImplementationOnce(() => { throw new ConflictException({ message: 'root changed', errorCode: 'workspace-git-path-check-failed' }); });
  try {
    spaces.preflightReservation(work, settings, 'git-worktree');
    expect(() => spaces.reserve(work, settings, 'git-worktree')).toThrow('root changed'); expect(check).toHaveBeenCalledTimes(2);
    expect(store.get(work.id)).toEqual(before); expect(work.workspace).toBeUndefined(); expect(work.executionPath).toBeUndefined();
  } finally { check.mockRestore(); }
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
it('unrelated 준비 흔적이 뒤늦게 생겨도 terminal rejected key의 fence를 우회하지 않는다', async () => {
  repository(); const preview = await provisioner.preview(work, 'main');
  const body = { requestKey: 'fenced-path', selectedBranch: 'main', previewToken: preview.documents!.confirmationToken, excludedConfirmed: true, policy: { version: 1, projectId: preview.projectId, planRevision: preview.documents!.planRevision, confirmed: true, runtime: 'none', dependencies: 'none', paths: [], generatedPaths: [], commands: [] } };
  const spaces = (provisioner as any).spaces as WorkspaceService;
  const fail = vi.spyOn(spaces, 'preflightReservation').mockImplementationOnce(() => { throw new ConflictException({ errorCode: 'workspace-git-path-unsupported' }); });
  await expect(provisioner.prepare(work, body)).rejects.toHaveProperty('response.mutationOutcome', 'rejected-before-intent'); fail.mockRestore();
  store.record('unrelated', work.id, 'workspace-preparation', { stage: 'copy', status: 'passed' });
  let rejected: any; try { await provisioner.prepare(work, body); } catch (error) { rejected = error; }
  expect(rejected).toBeInstanceOf(ConflictException); expect(rejected.getResponse()).not.toHaveProperty('mutationOutcome');
  expect(store.get(work.id)?.workspace).toBeUndefined(); expect(store.records(work.id, 'workspace-request')).toEqual([]); expect(store.records(work.id, 'workspace-creation')).toEqual([]);
});
