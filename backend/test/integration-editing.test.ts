import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/app';
import { WorkStore, type Work } from '../src/work/store';
import { WorkService } from '../src/work/work.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorktreeManager } from '../src/work/worktree-manager';
import { IntegrationPreparation } from '../src/work/integration-preparation';
import { collectWorkspaceDocuments } from '../src/work/workspace-documents';
import { DesktopLifecycle } from '../src/desktop/lifecycle';
import { projectCoordinator } from '../src/projects/coordinator';
import * as runner from '../src/projects/git-runner';
import { IntegrationEditing } from '../src/work/integration-editing';
import { createHash } from 'node:crypto';
vi.setConfig({ testTimeout: 120000, hookTimeout: 30000 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let app: any, base: string, source: string, store: WorkStore, work: Work, works: WorkService, reserved: any;
const savedEnv = { CONFIG_PATH: process.env.CONFIG_PATH, DATA_DIR: process.env.DATA_DIR, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
async function api(path: string, body?: unknown) { const r = await fetch(`${base}/api/work/a/integration/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; }
function verified() { const command = works.execution.commands(work)[0]; store.record('verified', 'a', 'verification', { commandId: command.id, scope: 'full', status: 'passed', revision: works.execution.revision(work), sourceMutationVersion: work.sourceMutationVersion, commandVersion: JSON.stringify(command) }); }
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c-')); source = join(dir, 's'); mkdirSync(source); mkdirSync(join(dir, 'c'));
  git(source, 'init', '-b', 'main'); git(source, 'config', 'core.autocrlf', 'false'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test');
  const docs = join(source, 'openspec/changes/a'); mkdirSync(join(docs, 'specs/demo'), { recursive: true });
  for (const path of ['proposal.md', 'design.md', 'tasks.md', 'specs/demo/spec.md']) writeFileSync(join(docs, path), '# Plan\n');
  writeFileSync(join(source, 'code.txt'), 'base\n'); git(source, 'add', '--all'); git(source, 'commit', '-m', 'fixture');
  process.env.CONFIG_PATH = join(dir, 'c/config.json'); process.env.DATA_DIR = join(dir, 'd'); delete process.env.WORKSPACE_ROOT;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(source, 'openspec') }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl(); store = app.get(WorkStore); works = app.get(WorkService);
  const settings = app.get(WorkspaceSettingsService), current = settings.read(), check = settings.check({ version: current.version, path: join(dir, 'r') }); settings.save({ version: current.version, token: check.token, confirmed: true });
  work = { id: 'a', sourceId: 'demo', projectPath: source, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'verification', state: 'idle', threadId: 'fixture', reviewedVersion: 'plan', createdAt: '', updatedAt: '' }; store.save(work);
  const head = git(source, 'rev-parse', 'HEAD'); await new WorktreeManager({ store }).create(work, settings, { requestKey: 'create', selectedBranch: 'main', baseCommit: head, sourceHead: head });
  work.workspace!.status = 'ready'; work.workspace!.workspaceBaselineCommit = head; work.workspace!.sourcePlanRevision = collectWorkspaceDocuments(source, 'a').planRevision; store.save(work);
  work.reviewedVersion = works.planVersion(work); work.verificationCommands = [{ id: 'fixture', command: 'fixture', args: [] }]; store.save(work);
});
afterEach(async () => { await app?.close(); vi.restoreAllMocks(); for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
async function result(change = true, targetChange?: string, fullApi = false) {
  if (targetChange) { writeFileSync(join(source, targetChange), 'target\n'); git(source, 'add', '--', targetChange); git(source, 'commit', '-m', 'target'); }
  if (change) writeFileSync(join(work.executionPath!, 'code.txt'), 'result\n');
  verified(); const head = git(work.executionPath!, 'rev-parse', 'HEAD');
  const request = await api('', { requestKey: 'integrate', confirmed: true, targetBranch: 'main', expectedWorkHead: head, expectedTargetHead: git(source, 'rev-parse', 'HEAD'), reviewedVersion: work.reviewedVersion }); expect(request.status).toBe(200); reserved = request.data;
  if (!fullApi) {
    // 5.2 is covered by its own API suite and the complete flows below. Seed only
    // its real immutable Git outcome; 5.3 prepare and every 5.5 gate remain real.
    const sourceBefore = git(source, 'rev-parse', 'HEAD') + git(source, 'ls-files', '--stage');
    const paths = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: work.executionPath!, windowsHide: true }).toString().split('\0').filter(Boolean).map(row => row.slice(3)).sort();
    if (paths.length) git(work.executionPath!, 'add', '-A', '--', ...paths);
    const tree = git(work.executionPath!, 'write-tree'), message = '5.5 fixture verified work result', ref = `refs/heads/${work.workspace!.branch}`;
    const commit = paths.length ? git(work.executionPath!, 'commit-tree', tree, '-p', head, '-m', message) : head;
    if (paths.length) git(work.executionPath!, 'update-ref', '--no-deref', ref, commit, head);
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'), id = `result-commit:${digest(['a', 'result'])}`, intentId = `${id}:git`;
    const intent = { scope: 'index', root: work.executionPath!, commonDir: reserved.commonDir, refs: [ref], affectedRoots: [work.executionPath!], status: 'passed' };
    const row = { id, intentId, workId: 'a', integrationId: reserved.id, fingerprint: digest({ integrationId: reserved.id, requestKey: 'result', confirmed: true, previewVersion: 'fixture', paths, message }), root: work.executionPath!, ref, startHead: head, sourceRevision: reserved.sourceRevision, verificationRefs: reserved.workVerificationRefs, message, paths, status: paths.length ? 'committed' : 'noop', intent, processTerminated: true, ...(paths.length ? { commitObject: commit, expectedTree: tree, refUpdateCompleted: true } : {}), commit, tree };
    store.transaction(() => { store.record(id, 'a', 'integration-result-commit', row); store.record(intentId, 'a', 'workspace-git-intent', intent); store.record(reserved.id, 'a', 'integration-request', { ...reserved, resultCommit: commit, resultTree: tree }); });
    expect(git(work.executionPath!, 'rev-parse', 'HEAD')).toBe(commit); expect(git(work.executionPath!, 'rev-parse', 'HEAD^{tree}')).toBe(tree); expect(git(work.executionPath!, 'status', '--porcelain')).toBe(''); expect(git(source, 'rev-parse', 'HEAD') + git(source, 'ls-files', '--stage')).toBe(sourceBefore);
    reserved = store.integrationRequests()[0]; return row;
  }
  const preview = await api('commit-preview'); expect(preview.status).toBe(200);
  const committed = await api('result-commit', { integrationId: reserved.id, requestKey: 'result', confirmed: true, previewVersion: preview.data.version, paths: preview.data.entries.filter((e: any) => e.selectable).map((e: any) => e.path), message: '검증 결과' }); expect(['committed', 'noop']).toContain(committed.data.status);
  reserved = store.integrationRequests()[0]; return committed.data;
}
async function prepare() { const preview = await api(`${reserved.candidateId}/preview`); expect(preview.status).toBe(200); return { requestKey: 'candidate', confirmed: true, expectedVersion: preview.data.candidateVersion }; }
async function candidate(conflict = true, fullApi = false) { await result(true, conflict ? 'code.txt' : 'target.txt', fullApi); const prepared = await api(`${reserved.candidateId}/prepare`, await prepare()); expect(prepared.data.status).toBe(conflict ? 'conflicted' : 'validating'); reserved = store.integrationRequests()[0]; }
async function file(body?: unknown) { const response = await fetch(`${base}/api/projects/demo/file?workId=a&candidateId=${reserved.candidateId}&path=code.txt`, { method: body === undefined ? 'GET' : 'PUT', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; }
async function project(endpoint: string, method = 'GET', body?: unknown) { const response = await fetch(`${base}/api/projects/demo/${endpoint}${endpoint.includes('?') ? '&' : '?'}workId=a&candidateId=${reserved.candidateId}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; }
const editing = (endpoint: string, body?: unknown) => api(`${reserved.candidateId}/edit/${endpoint}`, body);
it.each([true, false])('후보 conflict=%s 편집·stage·명시커밋은 원본/업무를 보존하고 후보 검증만 무효화한다', async conflict => {
  await candidate(conflict, true); const original = git(source, 'rev-parse', 'HEAD'), originalIndex = git(source, 'ls-files', '--stage'), head = git(work.executionPath!, 'rev-parse', 'HEAD'), index = git(work.executionPath!, 'ls-files', '--stage'), savedWork = store.get('a'), old = reserved.candidateCommit;
  store.record(reserved.id, 'a', 'integration-request', { ...reserved, verificationRefs: ['candidate-proof'], ...(conflict ? {} : { status: 'ready' }) });
  const read = await file(); expect(read.status).toBe(200); expect(read.data, JSON.stringify({ path: read.data.path, editable: read.data.editable, reason: read.data.reason })).toMatchObject({ path: 'code.txt', editable: true }); expect(read.data.content).toBe(readFileSync(reserved.executionPath + '/code.txt', 'utf8')); expect(read.data.version).toMatch(/^[a-f0-9]{64}$/); expect(read.data.candidateVersion).toMatch(/^[a-f0-9]{64}$/);
  const save = await file({ path: 'code.txt', content: 'resolved\n', version: read.data.version, candidateVersion: read.data.candidateVersion }); expect(save.status).toBe(200); expect(save.data.content).toBe('resolved\n'); expect(store.integrationRequests()[0].verificationRefs).toEqual([]);
  expect(read.data.mode).toBe(conflict ? 'conflict' : 'revision'); expect(save.data.candidateVersion).toMatch(/^[a-f0-9]{64}$/);
  const paths = ['code.txt'], stageInput = { requestKey: 'stage', confirmed: true, candidateVersion: save.data.candidateVersion, paths }, stage = await editing('stage', stageInput); expect(stage.data.status).toBe('staged'); expect(stage.data.afterVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(git(reserved.executionPath, 'diff', '--cached', '--no-renames', '--name-only')).toBe('code.txt');
  const commitInput = { requestKey: 'commit', confirmed: true, candidateVersion: stage.data.afterVersion, paths, message: '후보 해결 반영' };
  const commit = await editing('commit', commitInput); expect(commit.data.status).toBe('committed'); expect(git(reserved.executionPath, 'show', '-s', '--format=%P')).toBe(conflict ? `${reserved.targetHead} ${reserved.resultCommit}` : old); expect(git(reserved.executionPath, 'show', 'HEAD:code.txt')).toBe('resolved'); expect(git(reserved.executionPath, 'rev-parse', 'HEAD^{tree}')).toBe(commit.data.tree);
  expect(git(source, 'rev-parse', 'HEAD')).toBe(original); expect(git(source, 'ls-files', '--stage')).toBe(originalIndex); expect(git(work.executionPath!, 'rev-parse', 'HEAD')).toBe(head); expect(git(work.executionPath!, 'ls-files', '--stage')).toBe(index); expect(store.get('a')).toEqual(savedWork); expect(app.get(DesktopLifecycle).requests).toBe(0);
});
it('seed된 결과의 stale 파일 CAS·commit replay·stage 영수증을 독립 검증한다', async () => {
  await candidate(); const read = await file(), save = await file({ path: 'code.txt', content: 'resolved\n', version: read.data.version }); expect(save.status).toBe(200);
  const stale = await file({ path: 'code.txt', content: 'stale', version: read.data.version }); expect(stale.status).toBe(409); expect(stale.data.latest).toMatchObject({ path: 'code.txt', content: 'resolved\n', editable: true, version: save.data.version, candidateVersion: save.data.candidateVersion });
  const preview = await editing('preview'), stageInput = { requestKey: 'receipt-stage', confirmed: true, candidateVersion: preview.data.candidateVersion, paths: ['code.txt'] };
  expect((await editing('stage', stageInput)).data.status).toBe('staged'); const current = await editing('preview'), input = { requestKey: 'receipt-commit', confirmed: true, candidateVersion: current.data.candidateVersion, paths: ['code.txt'], message: '명시 해결' };
  const commit = await editing('commit', input); expect(commit.data.status).toBe('committed'); expect((await editing('commit', Object.fromEntries(Object.entries(input).reverse()))).data.commit).toBe(commit.data.commit);
  expect((await editing('stage', stageInput)).data).toMatchObject({ status: 'staged', fresh: false, superseded: true }); expect(store.integrationRequests()[0].candidateCommit).toBe(commit.data.commit);
});
it('stale 파일 저장은 다른 창의 새 ready 검증 refs와 epoch를 무효화하지 않는다', async () => {
  await candidate(false); const read = await file(), service = app.get(IntegrationEditing) as any, checkpoint = service.editingBasis.bind(service); let newer: any;
  const spy = vi.spyOn(service, 'editingBasis').mockImplementation(async (...args: any[]) => {
    if (args[1] && !newer) { newer = { ...store.integrationRequests()[0], status: 'ready', candidateMutationVersion: 'another-window', verificationRefs: ['new-proof'], updatedAt: 'new-ready' }; store.record(newer.id, 'a', 'integration-request', newer); }
    return checkpoint(...args);
  });
  try { expect((await file({ path: 'code.txt', content: 'stale save', version: read.data.version })).status).toBe(409); expect(store.integrationRequests()[0]).toEqual(newer); expect(store.records('a', 'integration-edit')).toEqual([]); expect(readFileSync(join(reserved.executionPath, 'code.txt'), 'utf8')).toBe('result\n'); } finally { spy.mockRestore(); }
});
async function resolved() { await candidate(); const read = await file(); await file({ path: 'code.txt', content: 'resolved\n', version: read.data.version }); const preview = await editing('preview'); await editing('stage', { requestKey: 'resolve-stage', confirmed: true, candidateVersion: preview.data.candidateVersion, paths: ['code.txt'] }); const current = await editing('preview'); return { requestKey: 'resolve-commit', confirmed: true, candidateVersion: current.data.candidateVersion, paths: ['code.txt'], message: '명시 해결' }; }
it('commit-object 도중 후보 소스 변경은 CAS 전에 차단한다', async () => {
  const input = await resolved(), actual = runner.runGit;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => { const output = await actual(root, args, options, optional); if (root === reserved.executionPath && args.includes('commit-tree')) writeFileSync(join(root, 'code.txt'), 'later'); return output; });
  expect((await editing('commit', input)).data.status).toBe('failed'); expect(git(reserved.executionPath, 'rev-parse', 'HEAD')).toBe(reserved.targetHead);
});
it('CAS 뒤 응답 유실은 자동 입력 없이 정확한 증거와 명시 reconcile로 병합 종료만 복구한다', async () => {
  const input = await resolved(), actual = runner.runGit; let injected = false;
  const spy = vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => { const output = await actual(root, args, options, optional); if (!injected && root === reserved.executionPath && args.includes('update-ref')) { injected = true; throw new runner.GitError('lost CAS reply', 409, true, true); } return output; });
  expect((await editing('commit', input)).data.status).toBe('uncertain'); spy.mockRestore(); const committed = git(reserved.executionPath, 'rev-parse', 'HEAD'); expect(committed).not.toBe(reserved.targetHead); expect(git(reserved.executionPath, 'rev-parse', 'MERGE_HEAD')).toBe(reserved.resultCommit);
  expect((await editing('commit', input)).data.status).toBe('uncertain'); const result = await editing('reconcile', { requestKey: input.requestKey, confirmed: true }); expect(result.data).toMatchObject({ status: 'committed', commit: committed }); expect(store.integrationRequests()[0]).toMatchObject({ status: 'validating', candidateCommit: committed });
  await vi.waitFor(() => expect(app.get(DesktopLifecycle).requests).toBe(0), { timeout: 4000 });
});
it('PID 부재와 stale recovery claim은 실제 종료 근거 없이 복구·해제하지 않는다', async () => {
  const input = await resolved(), actual = runner.runGit; let injected = false;
  const spy = vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => { const output = await actual(root, args, options, optional); if (!injected && root === reserved.executionPath && args.includes('update-ref')) { injected = true; throw new runner.GitError('restart fixture', 409, true, true); } return output; });
  await editing('commit', input); spy.mockRestore(); const row = store.records('a', 'integration-edit').find(row => row.kind === 'commit')!;
  store.record(row.id, 'a', 'integration-edit', { ...row, recoveryToken: 'live', recoveryOwnerProcessId: process.pid });
  expect((await editing('reconcile', { requestKey: input.requestKey, confirmed: true })).data.status).toBe('uncertain'); expect(git(reserved.executionPath, 'rev-parse', 'MERGE_HEAD')).toBe(reserved.resultCommit);
  const dead = 2147483646, probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  try {
    const saved = { ...row, processTerminated: false, processId: dead, recoveryToken: 'stale', recoveryOwnerProcessId: dead };
    store.record(row.id, 'a', 'integration-edit', saved);
    const response = await editing('reconcile', { requestKey: input.requestKey, confirmed: true });
    expect(response.data.status).toBe('uncertain'); expect(probe).not.toHaveBeenCalled();
    expect(store.records('a', 'integration-edit').find(item => item.id === row.id)).toMatchObject(saved);
    expect(git(reserved.executionPath, 'rev-parse', 'MERGE_HEAD')).toBe(reserved.resultCommit);
  } finally { probe.mockRestore(); }
});
it('다른 후보 epoch·미소유 MERGE_HEAD·비밀 파일 저장을 거부한다', async () => {
  await candidate(); const read = await file(); expect((await file({ path: '.env', content: 'secret', version: read.data.version })).status).toBeGreaterThanOrEqual(400);
  expect((await file({ path: 'code.txt', content: 'wrong', version: read.data.version, candidateVersion: '0'.repeat(64) })).status).toBe(409);
  const path = git(reserved.executionPath, 'rev-parse', '--git-path', 'MERGE_HEAD'); writeFileSync(resolve(reserved.executionPath, path), reserved.targetHead + '\n'); expect((await editing('preview')).status).toBe(409);
});
it('대상 내용 그대로 해결하여 diff가 없어도 소유 충돌의 두 부모 커밋을 만든다', async () => {
  await candidate(); const ours = execFileSync('git', ['show', `${reserved.targetHead}:code.txt`], { cwd: source }).toString(), read = await file(); await file({ path: 'code.txt', content: ours, version: read.data.version });
  const before = await editing('preview'), input = { requestKey: 'ours-stage', confirmed: true, candidateVersion: before.data.candidateVersion, paths: ['code.txt'] };
  const staged = await editing('stage', input); expect(staged.data.status).toBe('staged'); expect((await editing('stage', Object.fromEntries(Object.entries(input).reverse()))).data.status).toBe('staged');
  const preview = await editing('preview'); expect(preview.data.entries).toEqual([]);
  const commit = await editing('commit', { requestKey: 'ours-commit', confirmed: true, candidateVersion: preview.data.candidateVersion, paths: [], message: '대상 내용으로 충돌 해결' });
  expect(commit.data.status).toBe('committed'); expect(git(reserved.executionPath, 'show', '-s', '--format=%P')).toBe(`${reserved.targetHead} ${reserved.resultCommit}`); expect(git(reserved.executionPath, 'rev-parse', 'HEAD^{tree}')).toBe(git(source, 'rev-parse', `${reserved.targetHead}^{tree}`));
});
it('stage 중 실제 소스가 바뀌면 커밋하지 않고 알려진 실패는 새 명시 키를 허용한다', async () => {
  await candidate(); const read = await file(); await file({ path: 'code.txt', content: 'resolved\n', version: read.data.version }); const preview = await editing('preview'), actual = runner.runGit;
  const spy = vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => { if (args.includes('add')) throw new runner.GitError('known fixture failure'); return actual(root, args, options, optional); });
  const input = { requestKey: 'failed', confirmed: true, candidateVersion: preview.data.candidateVersion, paths: ['code.txt'] }; expect((await editing('stage', input)).data.status).toBe('failed'); spy.mockRestore(); const renewed = await editing('preview'); expect((await editing('stage', { ...input, requestKey: 'fresh', candidateVersion: renewed.data.candidateVersion })).data.status).toBe('staged'); expect(git(reserved.executionPath, 'rev-parse', 'HEAD')).toBe(reserved.targetHead);
});
it('modify/delete 충돌을 파일 명시 삭제로 해결하고 두 부모 커밋을 만든다', async () => {
  unlinkSync(join(work.executionPath!, 'code.txt')); await result(false, 'code.txt'); expect((await api(`${reserved.candidateId}/prepare`, await prepare())).data.status).toBe('conflicted'); reserved = store.integrationRequests()[0];
  const read = await file(), removed = await project('file', 'DELETE', { path: 'code.txt', version: read.data.version, confirmed: true, candidateVersion: read.data.candidateVersion }); expect(removed.status).toBe(200); expect(existsSync(join(reserved.executionPath, 'code.txt'))).toBe(false);
  const preview = await editing('preview'); expect((await editing('stage', { requestKey: 'delete-stage', confirmed: true, candidateVersion: preview.data.candidateVersion, paths: ['code.txt'] })).data.status).toBe('staged');
  const current = await editing('preview'), committed = await editing('commit', { requestKey: 'delete-commit', confirmed: true, candidateVersion: current.data.candidateVersion, paths: ['code.txt'], message: '명시 삭제로 충돌 해결' }); expect(committed.data.status).toBe('committed'); expect(git(reserved.executionPath, 'ls-tree', 'HEAD', '--', 'code.txt')).toBe('');
});
it('후보 삭제 파일의 명시 복원과 이름 이동도 CAS·선택 stage·두 부모 커밋을 사용한다', async () => {
  await candidate(); const protectedBefore = [source, work.executionPath!].map(root => [git(root, 'rev-parse', 'HEAD'), git(root, 'ls-files', '--stage')]), candidateHead = git(reserved.executionPath, 'rev-parse', 'HEAD');
  const read = await file(), removed = await project('file', 'DELETE', { path: 'code.txt', version: read.data.version, candidateVersion: read.data.candidateVersion, confirmed: true }); expect(removed.status).toBe(200); expect(removed.data.candidateVersion).toMatch(/^[a-f0-9]{64}$/);
  const restored = await project('entries', 'POST', { path: 'code.txt', kind: 'file', content: 'restored\n', candidateVersion: removed.data.candidateVersion }); expect(restored.status).toBe(201); expect(restored.data.content).toBe('restored\n'); expect(restored.data.version).toMatch(/^[a-f0-9]{64}$/);
  const moved = await project('entries/move', 'POST', { path: 'code.txt', target: 'renamed.txt', version: restored.data.version, candidateVersion: restored.data.candidateVersion }); expect(moved.status).toBe(201); expect(existsSync(join(reserved.executionPath, 'code.txt'))).toBe(false); expect(readFileSync(join(reserved.executionPath, 'renamed.txt'), 'utf8')).toBe('restored\n'); expect(git(reserved.executionPath, 'rev-parse', 'HEAD')).toBe(candidateHead);
  const paths = ['code.txt', 'renamed.txt'], staged = await editing('stage', { requestKey: 'rename-stage', confirmed: true, candidateVersion: moved.data.candidateVersion, paths }); expect(staged.data.status).toBe('staged'); expect(staged.data.afterVersion).toMatch(/^[a-f0-9]{64}$/);
  expect(git(reserved.executionPath, 'diff', '--cached', '--no-renames', '--name-only').split('\n').sort()).toEqual(paths);
  const committed = await editing('commit', { requestKey: 'rename-commit', confirmed: true, candidateVersion: staged.data.afterVersion, paths, message: '명시 복원과 이름 정리' }); expect(committed.data.status).toBe('committed'); expect(git(reserved.executionPath, 'show', '-s', '--format=%P')).toBe(`${reserved.targetHead} ${reserved.resultCommit}`); expect(git(reserved.executionPath, 'rev-parse', 'HEAD^{tree}')).toBe(committed.data.tree); expect(git(reserved.executionPath, 'show', 'HEAD:renamed.txt')).toBe('restored'); expect(git(reserved.executionPath, 'ls-tree', 'HEAD', '--', 'code.txt')).toBe('');
  expect([source, work.executionPath!].map(root => [git(root, 'rev-parse', 'HEAD'), git(root, 'ls-files', '--stage')])).toEqual(protectedBefore); expect(app.get(DesktopLifecycle).requests).toBe(0);
});
it.each(['source', 'target'])('directory 이동은 %s 하위 보호 경로를 mutation 전에 검사한다', async side => {
  const local = side === 'source' ? 'container/runtime-settings' : 'target/sub', digest = 'a'.repeat(64);
  work.workspace!.localOnlyPaths = [local]; work.workspace!.preparationPolicyDigest = digest; store.save(work);
  store.record('policy', 'a', 'workspace-local-policy', { policyDigest: digest, confirmed: true, paths: [], generatedPaths: [local] }); store.record('local-prepared', 'a', 'workspace-local-preparation', { policyDigest: digest, status: 'ready' });
  await candidate(false); const before = store.integrationRequests()[0], from = side === 'source' ? 'container' : 'public', target = side === 'source' ? 'renamed' : 'target', relative = side === 'source' ? `${from}/runtime-settings` : `${from}/sub/file.ts`;
  mkdirSync(join(reserved.executionPath, relative, '..'), { recursive: true }); writeFileSync(join(reserved.executionPath, relative), side === 'source' ? 'private fixture' : 'product fixture');
  const preview = await editing('preview'), entry = side === 'source' ? { data: { version: 'f'.repeat(64) } } : await project(`entry?path=${from}`);
  const response = await project('entries/move', 'POST', { path: from, target, version: entry.data.version, candidateVersion: preview.data.candidateVersion }); expect([403, 409]).toContain(response.status);
  expect(readFileSync(join(reserved.executionPath, relative), 'utf8')).toBe(side === 'source' ? 'private fixture' : 'product fixture'); expect(existsSync(join(reserved.executionPath, target))).toBe(false); expect(store.integrationRequests()[0]).toEqual(before);
});
it.each(['edit', 'delete'])('미지원 속성 파일도 raw FS로 %s 복구하며 Git 변환은 차단한다', async repair => {
  await candidate(false); const preview = await editing('preview');
  const created = await project('entries', 'POST', { path: '.gitattributes', kind: 'file', content: '*.txt filter=lfs\n', candidateVersion: preview.data.candidateVersion }); expect(created.status).toBe(201);
  const refreshed = await Promise.all([project('workspace'), project('git/status'), project('tree'), project('file?path=.gitattributes')]);
  expect(refreshed[0]).toMatchObject({ status: 200, data: { partial: true, partialReason: expect.stringMatching(/필터/), editContract: 'candidate-cas' } }); expect(refreshed[1].status).toBe(409); expect(refreshed[2].status).toBe(200);
  const read = refreshed[3]; expect(read.data).toMatchObject({ path: '.gitattributes', content: '*.txt filter=lfs\n', editable: true });
  expect((await editing('preview')).status).toBe(409);
  expect((await editing('stage', { requestKey: 'attrs-stage', confirmed: true, candidateVersion: read.data.candidateVersion, paths: ['code.txt'] })).status).toBe(409);
  expect((await editing('commit', { requestKey: 'attrs-commit', confirmed: true, candidateVersion: read.data.candidateVersion, paths: ['code.txt'], message: 'blocked' })).status).toBe(409);
  const repaired = repair === 'edit' ? await project('file', 'PUT', { path: '.gitattributes', content: '*.txt -filter\n', version: read.data.version }) : await project('file', 'DELETE', { path: '.gitattributes', version: read.data.version, confirmed: true });
  expect(repaired.status).toBe(200); expect((await editing('preview')).status).toBe(200); expect((await project('git/status')).status).toBe(200);
});
it.each(['source-plan', 'work-plan', 'derived-commands', 'work-source', 'work-index', 'target-ref', 'progress', 'verification-record', 'question', 'owner', 'candidate-head', 'candidate-progress', 'candidate-branch', 'final-work-source'])('요청 proof checkpoint await 중 %s 변경은 재검증 통과 없이 차단한다', async dimension => {
  if (dimension === 'derived-commands') {
    delete work.verificationCommands; store.save(work);
    writeFileSync(join(work.executionPath!, 'package.json'), JSON.stringify({ scripts: { test: 'fixture' } }));
  }
  await candidate(false);
  const preview = await editing('preview'), candidateHead = git(reserved.executionPath, 'rev-parse', 'HEAD'), beforeRequest = store.integrationRequests()[0];
  const readiness = vi.spyOn(works, 'integrationReadiness'), actual = runner.runGit; let reads = 0, injected = false;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    const output = await actual(root, args, options, optional);
    if (root === work.executionPath && args.includes('--show-origin') && ++reads === 3 && dimension !== 'final-work-source' || dimension === 'final-work-source' && !injected && root === reserved.executionPath && args.includes('symbolic-ref')) {
      injected = true;
      if (dimension === 'source-plan') writeFileSync(join(source, 'openspec/changes/a/design.md'), '# Changed source plan\n');
      if (dimension === 'work-plan') writeFileSync(join(work.executionPath!, 'openspec/changes/a/design.md'), '# Changed work plan\n');
      if (dimension === 'derived-commands') writeFileSync(join(work.executionPath!, 'package.json'), JSON.stringify({ scripts: { test: 'changed' } }));
      if (dimension === 'work-source' || dimension === 'final-work-source') writeFileSync(join(work.executionPath!, 'code.txt'), 'external work source\n');
      if (dimension === 'work-index') git(work.executionPath!, 'update-index', '--chmod=+x', '--', 'code.txt');
      if (dimension === 'target-ref') git(source, 'update-ref', 'refs/heads/main', reserved.resultCommit);
      if (dimension === 'progress') writeFileSync(resolve(work.executionPath!, git(work.executionPath!, 'rev-parse', '--git-path', 'CHERRY_PICK_HEAD')), reserved.resultCommit + '\n');
      if (dimension === 'verification-record') store.record('verified', 'a', 'verification', { ...store.records('a', 'verification')[0], status: 'failed' });
      if (dimension === 'question') store.record('external-question', 'a', 'question', { status: 'pending', question: 'Changed?' });
      if (dimension === 'candidate-head') git(reserved.executionPath, 'update-ref', 'refs/heads/codex/integration-' + reserved.candidateId, reserved.resultCommit);
      if (dimension === 'candidate-branch') git(reserved.executionPath, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      if (dimension === 'candidate-progress') writeFileSync(resolve(reserved.executionPath, git(reserved.executionPath, 'rev-parse', '--git-path', 'CHERRY_PICK_HEAD')), reserved.resultCommit + '\n');
      if (dimension === 'owner') writeFileSync(join(reserved.executionPath, '..', 'identity.json'), '{}');
    }
    return output;
  });
  const response = await editing('stage', { requestKey: `checkpoint-${dimension}`, confirmed: true, candidateVersion: preview.data.candidateVersion, paths: ['code.txt'] });
  expect(injected).toBe(true); expect(response.status).toBe(409); expect(readiness).toHaveBeenCalledTimes(1);
  if (!['candidate-head', 'candidate-branch'].includes(dimension)) expect(git(reserved.executionPath, 'rev-parse', 'HEAD')).toBe(candidateHead); expect(store.integrationRequests()[0]).toEqual(beforeRequest);
  expect(store.records('a', 'integration-edit')).toEqual([]); expect(app.get(DesktopLifecycle).requests).toBe(0);
});
it('파일 저장 요청은 full readiness 한 번만 검증하고 원본 proof를 매 checkpoint 대조한다', async () => {
  await candidate(false); const read = await file(), readiness = vi.spyOn(works, 'integrationReadiness');
  const saved = await file({ path: 'code.txt', content: 'request proof save\n', version: read.data.version });
  expect(saved.status, JSON.stringify({ path: saved.data.path, editable: saved.data.editable, reason: saved.data.reason, message: saved.data.message })).toBe(200); expect(readiness).toHaveBeenCalledTimes(1); expect(app.get(DesktopLifecycle).requests).toBe(0);
});
it('외부 AUTO_MERGE 치환은 후보 커밋 전에 차단하고 복구 ref를 보존한다', async () => {
  const input = await resolved(), path = resolve(reserved.executionPath, git(reserved.executionPath, 'rev-parse', '--git-path', 'AUTO_MERGE'));
  const owned = readFileSync(path, 'utf8'); expect(owned.trim()).not.toBe(reserved.resultTree);
  writeFileSync(path, reserved.resultTree + '\n');
  expect((await editing('commit', input)).status).toBe(409); expect(readFileSync(path, 'utf8')).toBe(reserved.resultTree + '\n');
  expect(git(reserved.executionPath, 'rev-parse', 'HEAD')).toBe(reserved.targetHead);
});
it('재시작 명시 복구는 저장된 AUTO_MERGE 소유가 돌아온 뒤에만 병합을 종료한다', async () => {
  const input = await resolved(), actual = runner.runGit; let lost = false;
  const spy = vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    const output = await actual(root, args, options, optional);
    if (!lost && root === reserved.executionPath && args.includes('update-ref')) { lost = true; throw new runner.GitError('lost CAS reply', 409, true, true); }
    return output;
  });
  expect((await editing('commit', input)).data.status).toBe('uncertain'); spy.mockRestore();
  const path = resolve(reserved.executionPath, git(reserved.executionPath, 'rev-parse', '--git-path', 'AUTO_MERGE')), owned = readFileSync(path, 'utf8');
  writeFileSync(path, reserved.resultTree + '\n');
  expect((await editing('reconcile', { requestKey: input.requestKey, confirmed: true })).data.status).toBe('uncertain'); expect(readFileSync(path, 'utf8')).toBe(reserved.resultTree + '\n');
  writeFileSync(path, owned);
  expect((await editing('reconcile', { requestKey: input.requestKey, confirmed: true })).data.status).toBe('committed'); expect(existsSync(path)).toBe(false);
});
it('관계없는 다른 업무 HEAD의 await 중 변경은 현재 후보 파일 저장을 막지 않는다', async () => {
  await candidate(false); const read = await file(), unrelated = join(source, '..', 'unrelated');
  git(source, 'worktree', 'add', '-b', 'unrelated-work', '--', unrelated, 'HEAD');
  const actual = runner.runGit; let reads = 0, injected = false;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    const output = await actual(root, args, options, optional);
    if (root === work.executionPath && args.includes('--show-origin') && ++reads === 3) { injected = true; git(unrelated, 'commit', '--allow-empty', '-m', 'other work'); }
    return output;
  });
  const saved = await file({ path: 'code.txt', content: 'unrelated work stays independent\n', version: read.data.version });
  expect(injected).toBe(true); expect(saved.status).toBe(200); expect(saved.data.content).toBe('unrelated work stays independent\n');
});
it('소유 merge-quit 성공 응답 유실은 명시 복구에서 종료만 관찰하고 quit를 반복하지 않는다', async () => {
  const input = await resolved(), actual = runner.runGit; let quits = 0;
  const spy = vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    const output = await actual(root, args, options, optional);
    if (root === reserved.executionPath && args.includes('merge') && args.includes('--quit')) { quits++; throw new runner.GitError('lost owned quit reply', 409, true, true); }
    return output;
  });
  expect((await editing('commit', input)).data.status).toBe('uncertain'); spy.mockRestore(); expect(quits).toBe(1);
  const finalizer = vi.spyOn(runner, 'runGit');
  expect((await editing('reconcile', { requestKey: input.requestKey, confirmed: true })).data.status).toBe('committed');
  expect(finalizer.mock.calls.some(([, args]) => args.includes('merge') && args.includes('--quit'))).toBe(false);
});
it('명시 reconcile quit의 성공 응답 유실 뒤에도 두 번째 reconcile은 쓰기 없이 완료를 관찰한다', async () => {
  const input = await resolved(), actual = runner.runGit; let lostCas = false;
  let spy = vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    const output = await actual(root, args, options, optional);
    if (!lostCas && root === reserved.executionPath && args.includes('update-ref')) { lostCas = true; throw new runner.GitError('lost CAS reply', 409, true, true); }
    return output;
  });
  expect((await editing('commit', input)).data.status).toBe('uncertain'); spy.mockRestore();
  let quits = 0;
  spy = vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    const output = await actual(root, args, options, optional);
    if (root === reserved.executionPath && args.includes('merge') && args.includes('--quit')) { quits++; throw new runner.GitError('lost explicit quit reply', 409, true, true); }
    return output;
  });
  expect((await editing('reconcile', { requestKey: input.requestKey, confirmed: true })).data.status).toBe('uncertain'); spy.mockRestore(); expect(quits).toBe(1);
  const row = store.records('a', 'integration-edit').find(item => item.kind === 'commit')!, intent = store.records('a', 'workspace-git-intent').find(item => item.id === row.intentIds.at(-1));
  expect(intent?.stage).toBe('explicit-merge-finalization'); expect(row).not.toHaveProperty('recoveryToken'); expect(row.processTerminated).toBe(true); expect(row.terminationProof).toMatchObject({ protocol: 'owned-git-job-v1', state: 'job-quiescent' }); expect(intent.terminationUnconfirmed).toBe(false);
  const finalizer = vi.spyOn(runner, 'runGit');
  const observed = await editing('reconcile', { requestKey: input.requestKey, confirmed: true }); expect(observed.data.status, observed.data.error).toBe('committed');
  expect(finalizer.mock.calls.some(([, args]) => args.includes('--quit') || args.includes('update-ref') || args.includes('commit-tree'))).toBe(false);
  await vi.waitFor(() => expect(app.get(DesktopLifecycle).requests).toBe(0), { timeout: 4000 });
});
it.each(['stage', 'commit'])('후보 %s stale 거부 marker는 후보 epoch/검증 refs와 intent를 바꾸지 않는다', async kind => {
  await candidate(false); const before = store.integrationRequests()[0], head = git(reserved.executionPath, 'rev-parse', 'HEAD');
  const input = { requestKey: `stale-${kind}`, confirmed: true, candidateVersion: '0'.repeat(64), paths: ['code.txt'], ...(kind === 'commit' ? { message: 'stale' } : {}) };
  const rejected = await editing(kind, input); expect(rejected).toMatchObject({ status: 409, data: { mutationOutcome: 'rejected-before-intent', requestKey: input.requestKey } });
  expect(store.integrationRequests()[0]).toEqual(before); expect(store.records('a', 'integration-edit')).toEqual([]); expect(git(reserved.executionPath, 'rev-parse', 'HEAD')).toBe(head);
  const changed = await editing(kind, { ...input, candidateVersion: 'f'.repeat(64) }); expect(changed.status).toBe(409); expect(changed.data).not.toHaveProperty('mutationOutcome');
});
it('후보 prepare stale 거부 marker는 준비 기록과 Git 후보를 생성하지 않는다', async () => {
  await result(); const input = { requestKey: 'prepare-stale', confirmed: true, expectedVersion: '0'.repeat(64) }, rejected = await api(`${reserved.candidateId}/prepare`, input);
  expect(rejected).toMatchObject({ status: 409, data: { mutationOutcome: 'rejected-before-intent', requestKey: input.requestKey } }); expect(store.records('a', 'integration-preparation')).toEqual([]); expect(existsSync(reserved.executionPath)).toBe(false);
  const changed = await api(`${reserved.candidateId}/prepare`, { ...input, expectedVersion: 'f'.repeat(64) }); expect(changed.status).toBe(409); expect(changed.data).not.toHaveProperty('mutationOutcome');
});
