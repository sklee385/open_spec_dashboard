import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let app: any, base: string, source: string, store: WorkStore, work: Work, works: WorkService, reserved: any;
const savedEnv = { CONFIG_PATH: process.env.CONFIG_PATH, DATA_DIR: process.env.DATA_DIR, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
async function api(path: string, body?: unknown) { const r = await fetch(`${base}/api/work/a/integration/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; }
function verified() { const command = works.execution.commands(work)[0]; store.record('verified', 'a', 'verification', { commandId: command.id, scope: 'full', status: 'passed', revision: works.execution.revision(work), sourceMutationVersion: work.sourceMutationVersion, commandVersion: JSON.stringify(command), evidenceVersion: 1, processTerminated: true, terminationEvidence: 'job-and-worker-closed', contextVersion: works.execution.verificationContext(work, command) }); }
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
async function result(change = true, targetChange?: string) {
  if (targetChange) { writeFileSync(join(source, targetChange), 'target\n'); git(source, 'add', '--', targetChange); git(source, 'commit', '-m', 'target'); }
  if (change) writeFileSync(join(work.executionPath!, 'code.txt'), 'result\n');
  verified(); const head = git(work.executionPath!, 'rev-parse', 'HEAD');
  const request = await api('', { requestKey: 'integrate', confirmed: true, targetBranch: 'main', expectedWorkHead: head, expectedTargetHead: git(source, 'rev-parse', 'HEAD'), reviewedVersion: work.reviewedVersion }); expect(request.status).toBe(200); reserved = request.data;
  const preview = await api('commit-preview'); expect(preview.status).toBe(200);
  const committed = await api('result-commit', { integrationId: reserved.id, requestKey: 'result', confirmed: true, previewVersion: preview.data.version, paths: preview.data.entries.filter((e: any) => e.selectable).map((e: any) => e.path), message: '검증 결과' }); expect(['committed', 'noop']).toContain(committed.data.status);
  reserved = store.integrationRequests()[0]; return committed.data;
}
async function prepare() { const preview = await api(`${reserved.candidateId}/preview`); expect(preview.status).toBe(200); return { requestKey: 'candidate', confirmed: true, expectedVersion: preview.data.candidateVersion }; }
it('merge.autostash 설정이 있어도 명시 no-autostash로 후보 dirty를 보존하며 stash를 만들지 않는다', async () => {
  await result(true, 'target.txt'); git(source, 'config', 'merge.autostash', 'true'); const input = await prepare(), before = git(source, 'stash', 'list'), actual = runner.runGit; let injected = false;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    if (!injected && root === reserved.executionPath && args.includes('merge') && args.includes('--no-commit')) { expect(args).toContain('--no-autostash'); injected = true; writeFileSync(join(root, 'code.txt'), 'external dirty\n'); }
    return actual(root, args, options, optional);
  });
  const response = await api(`${reserved.candidateId}/prepare`, input); expect(injected).toBe(true); expect(['failed', 'uncertain']).toContain(response.data.status); expect(readFileSync(join(reserved.executionPath, 'code.txt'), 'utf8')).toBe('external dirty\n'); expect(git(source, 'stash', 'list')).toBe(before);
  const dir = git(reserved.executionPath, 'rev-parse', '--absolute-git-dir'); expect(existsSync(join(dir, 'MERGE_AUTOSTASH'))).toBe(false);
});

it('외부 stage가 병합 뒤 들어오면 immutable merge tree 대조로 거부한다', async () => {
  await result(true, 'target.txt'); const input = await prepare(), actual = runner.runGit; let injected = false;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => { if (root === reserved.executionPath && args.includes('write-tree') && !injected) { injected = true; writeFileSync(join(root, 'outside.txt'), 'external'); git(root, 'add', '--', 'outside.txt'); } return actual(root, args, options, optional); });
  const response = await api(`${reserved.candidateId}/prepare`, input); expect(['failed', 'uncertain']).toContain(response.data.status); expect(response.data.candidateCommit).toBeNull(); expect(git(reserved.executionPath, 'rev-parse', 'HEAD')).toBe(reserved.targetHead);
});
it('다른 WorkStore는 Git 단계 사이에도 준비 전체의 잠금을 보며 원본의 다른 계획은 허용한다', async () => {
  await result(true, 'target.txt'); const input = await prepare(), actual = runner.runGit, other = new WorkStore(); let checked = false;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    if (root === reserved.executionPath && args.includes('merge-base') && !checked) {
      checked = true; const coordinator = projectCoordinator(other); expect(() => coordinator.assertWorkCanStart(other.get('a')!)).toThrow(/Git|미확인/);
      expect(() => coordinator.assertOperationCanStart({ kind: 'documents', root: source, changeName: 'b' })).not.toThrow();
      expect(other.records('a', 'workspace-git-intent').some(row => row.stage === 'candidate-preparation' && row.status === 'running')).toBe(true);
    }
    return actual(root, args, options, optional);
  });
  try { expect((await api(`${reserved.candidateId}/prepare`, input)).data.status).toBe('validating'); expect(checked).toBe(true); } finally { other.onApplicationShutdown(); }
});
it('같은 키 재조회는 ready 상태와 검증 refs·updatedAt을 되돌리지 않는다', async () => {
  await result(true, 'target.txt'); const input = await prepare(); expect((await api(`${reserved.candidateId}/prepare`, input)).data.status).toBe('validating');
  const ready = { ...store.integrationRequests()[0], status: 'ready', verificationRefs: ['candidate-proof'], updatedAt: '2026-10-30T00:00:00Z' }; store.record(ready.id, 'a', 'integration-request', ready);
  const response = await api(`${reserved.candidateId}/prepare`, input); expect(response.data).toEqual(ready); expect(store.integrationRequests()[0]).toEqual(ready);
});
it('CAS 성공 응답 유실은 저장 commitObject와 owned merge 잔여를 남기고 외부 정리 뒤 관찰 복구한다', async () => {
  await result(true, 'target.txt'); const input = await prepare(), actual = runner.runGit; let lost = false;
  const spy = vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    const output = await actual(root, args, options, optional); if (root === reserved.executionPath && args.includes('update-ref') && !lost) { lost = true; throw new runner.GitError('CAS response lost', 409, true); } return output;
  });
  const response = await api(`${reserved.candidateId}/prepare`, input); expect(response.data.status).toBe('uncertain'); const record = store.records('a', 'integration-preparation')[0], head = git(reserved.executionPath, 'rev-parse', 'HEAD');
  expect(record.commit).toBeUndefined(); expect(record.commitObject).toBe(head); expect(git(reserved.executionPath, 'rev-parse', 'MERGE_HEAD')).toBe(reserved.resultCommit);
  expect((await api(`${reserved.candidateId}/prepare`, input)).data.status).toBe('uncertain'); spy.mockRestore(); git(reserved.executionPath, 'merge', '--quit');
  const replay = await api(`${reserved.candidateId}/prepare`, input); expect(replay.data).toMatchObject({ status: 'validating', candidateCommit: head });
});
it('응답 유실 후 재조회도 변경된 업무 소스·검증 기준을 우회하지 않는다', async () => {
  await result(true, 'target.txt'); const input = await prepare(), record = store.record.bind(store); let failed = false;
  vi.spyOn(store, 'record').mockImplementation((id, workId, kind, data: any) => { if (!failed && kind === 'integration-request' && data.status === 'validating') { failed = true; throw new Error('publication lost'); } return record(id, workId, kind, data); });
  expect((await api(`${reserved.candidateId}/prepare`, input)).data.status).toBe('uncertain'); writeFileSync(join(work.executionPath!, 'outside.txt'), 'outside');
  expect((await api(`${reserved.candidateId}/prepare`, input)).data.status).toBe('uncertain'); expect(store.integrationRequests()[0].status).toBe('uncertain');
});

it('명시 후보 병합은 원본 dirty와 업무 ref/index를 보존하고 두 부모·tree를 검증한다', async () => {
  await result(true, 'target.txt'); writeFileSync(join(source, 'unrelated.txt'), 'original dirty'); const head = git(source, 'rev-parse', 'HEAD'), index = git(work.executionPath!, 'ls-files', '--stage');
  const input = await prepare(), response = await api(`${reserved.candidateId}/prepare`, input);
  expect(response.status).toBe(200); expect(response.data.status).toBe('validating'); const path = reserved.executionPath, commit = response.data.candidateCommit;
  expect(git(path, 'show', '-s', '--format=%P', commit)).toBe(`${reserved.targetHead} ${reserved.resultCommit}`); expect(git(path, 'show', 'HEAD:code.txt')).toBe('result'); expect(git(path, 'show', 'HEAD:target.txt')).toBe('target');
  expect(git(source, 'rev-parse', 'HEAD')).toBe(head); expect(readFileSync(join(source, 'unrelated.txt'), 'utf8')).toBe('original dirty'); expect(git(work.executionPath!, 'rev-parse', 'HEAD')).toBe(reserved.resultCommit); expect(git(work.executionPath!, 'ls-files', '--stage')).toBe(index);
  expect(await api(`${reserved.candidateId}/prepare`, input)).toEqual(response); expect((await api(`${reserved.candidateId}/prepare`, { ...input, expectedVersion: '0'.repeat(64) })).status).toBe(409);
  expect(store.get('a')?.workspace?.executionPath).toBe(work.executionPath); expect(app.get(DesktopLifecycle).requests).toBe(0);
});
it('같은 파일 충돌은 후보 소유 MERGE_HEAD와 unmerged index만 conflicted로 남긴다', async () => {
  await result(true, 'code.txt'); const response = await api(`${reserved.candidateId}/prepare`, await prepare());
  expect(response.data.status).toBe('conflicted'); expect(response.data.conflicts).toContain('code.txt'); expect(git(reserved.executionPath, 'rev-parse', 'MERGE_HEAD')).toBe(reserved.resultCommit); expect(git(reserved.executionPath, 'rev-parse', 'HEAD')).toBe(reserved.targetHead);
});
it('이미 포함된 noop 결과는 검증된 대상 HEAD를 후보로 쓴다', async () => {
  await result(false); const response = await api(`${reserved.candidateId}/prepare`, await prepare()); expect(response.data.status).toBe('validating'); expect(response.data.candidateCommit).toBe(reserved.targetHead);
});
it('미리보기 뒤 대상 이동과 업무 외부 소스 추가는 후보 실물 생성 전에 차단한다', async () => {
  await result(); const input = await prepare(); writeFileSync(join(source, 'later.txt'), 'later'); git(source, 'add', '--', 'later.txt'); git(source, 'commit', '-m', 'later');
  expect((await api(`${reserved.candidateId}/prepare`, input)).status).toBe(409); expect(existsSync(reserved.executionPath)).toBe(false);
});
it('결과 커밋 뒤 검증 밖 소스가 남으면 미리보기를 거부한다', async () => {
  await result(); writeFileSync(join(work.executionPath!, 'outside.txt'), 'outside'); const response = await api(`${reserved.candidateId}/preview`); expect(response.status).toBe(409); expect(existsSync(reserved.executionPath)).toBe(false);
});
it.each(['path', 'branch'])('기존 %s를 후보 소유로 채택하지 않는다', async kind => {
  await result(); const input = await prepare();
  if (kind === 'path') mkdirSync(reserved.executionPath, { recursive: true }); else git(source, 'branch', `codex/integration-${reserved.candidateId}`, reserved.targetHead);
  const response = await api(`${reserved.candidateId}/prepare`, input); expect(response.data.status === 'failed' || response.status === 409).toBe(true); expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.targetHead);
});
it('후보 CAS 뒤 응답 저장 실패는 정확한 marker/OID/부모/tree 재조회로 복구한다', async () => {
  await result(true, 'target.txt'); const input = await prepare(), record = store.record.bind(store); let failed = false;
  vi.spyOn(store, 'record').mockImplementation((id, workId, kind, data: any) => { if (!failed && kind === 'integration-request' && data.status === 'validating') { failed = true; throw new Error('fixture persistence'); } return record(id, workId, kind, data); });
  const response = await api(`${reserved.candidateId}/prepare`, input); expect(response.data.status).toBe('uncertain'); const head = git(reserved.executionPath, 'rev-parse', 'HEAD');
  const replay = await api(`${reserved.candidateId}/prepare`, input); expect(replay.data).toMatchObject({ status: 'validating', candidateCommit: head });
});
it('생성 실패는 intent를 남기고 자동 재실행하지 않는다', async () => {
  await result(); const input = await prepare(), actual = runner.runGit; let adds = 0;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => { if (args.includes('add') && args.includes('worktree')) { adds++; throw new runner.GitError('fixture creation failure'); } return actual(root, args, options, optional); });
  const response = await api(`${reserved.candidateId}/prepare`, input); expect(response.data.status).toBe('failed'); expect(store.records('a', 'workspace-git-intent').some(row => row.scope === 'management' && row.status === 'failed')).toBe(true);
  await api(`${reserved.candidateId}/prepare`, input); expect(adds).toBe(1);
});
// Actual Git fixtures exercise isolation; these tests do not touch configured user repositories.

it('사용하지 않는 시스템 LFS와 fixture의 filter·merge driver 정의는 일반 후보를 막지 않는다', async () => {
  await result(true, 'target.txt');
  // Windows Git's system LFS definitions are deliberately left intact; fixture-local definitions are additive.
  for (const key of ['filter.unused.clean', 'filter.unused.smudge', 'filter.unused.process', 'merge.unused.driver']) git(source, 'config', '--local', key, 'echo unused');
  const input = await prepare(), response = await api(`${reserved.candidateId}/prepare`, input);
  expect(response.status).toBe(200); expect(response.data.status).toBe('validating');
});
function targetAttributes(attributes: string) {
  // Plumbing creates the immutable target fixture without running the attributes being tested.
  const parent = git(source, 'rev-parse', 'HEAD');
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: source, input: attributes, encoding: 'utf8', windowsHide: true }).trim();
  git(source, 'update-index', '--add', '--cacheinfo', `100644,${blob},.gitattributes`);
  const tree = git(source, 'write-tree'), commit = git(source, 'commit-tree', tree, '-p', parent, '-m', 'immutable attributes fixture');
  git(source, 'update-ref', '--no-deref', 'refs/heads/main', commit, parent);
}
it.each(['filter=lfs', 'working-tree-encoding=UTF-16', 'ident'])('대상 immutable commit의 실제 %s 변환은 checkout 전 차단한다', async attribute => {
  targetAttributes(`code.txt ${attribute}\n`); await result();
  const response = await api(`${reserved.candidateId}/preview`); expect(response.status).toBe(409); expect(response.data.message).toMatch(/filter|인코딩|ident/); expect(existsSync(reserved.executionPath)).toBe(false);
});
it.each(['filter=lfs', 'merge=custom'])('안전 사전검사는 result immutable commit의 %s 적용도 검사한다', async attribute => {
  await result(); targetAttributes(`code.txt ${attribute}\n`); git(source, 'config', '--local', 'merge.custom.driver', 'echo unsafe');
  const preparation = new IntegrationPreparation(store, works, app.get(WorkspaceSettingsService), app.get(DesktopLifecycle));
  const withAttributedResult = { ...reserved, resultCommit: git(source, 'rev-parse', 'HEAD') };
  await expect((preparation as any).safeGit(withAttributedResult)).rejects.toThrow(/filter|merge driver/); expect(existsSync(reserved.executionPath)).toBe(false);
});
it.each(['custom', 'text', 'binary', 'union'])('이름이 %s인 실제 선택 custom driver 정의는 builtin 이름도 우회하지 못한다', async name => {
  targetAttributes(`code.txt merge=${name}\n`); await result(); git(source, 'config', '--local', `merge.${name}.driver`, 'echo unsafe');
  const response = await api(`${reserved.candidateId}/preview`); expect(response.status).toBe(409); expect(response.data.message).toMatch(/merge driver/); expect(existsSync(reserved.executionPath)).toBe(false);
});
it('merge 속성이 unspecified일 때 선택되는 merge.default custom driver도 차단한다', async () => {
  await result(); git(source, 'config', '--local', 'merge.default', 'custom'); git(source, 'config', '--local', 'merge.custom.driver', 'echo unsafe');
  const response = await api(`${reserved.candidateId}/preview`); expect(response.status).toBe(409); expect(response.data.message).toMatch(/merge driver/); expect(existsSync(reserved.executionPath)).toBe(false);
});
it.each(['text', 'binary', 'union'])('merge.default=%s도 같은 이름 custom 정의를 선택하면 차단한다', async name => {
  await result(); git(source, 'config', '--local', 'merge.default', name); git(source, 'config', '--local', `merge.${name}.driver`, 'echo unsafe');
  const response = await api(`${reserved.candidateId}/preview`); expect(response.status).toBe(409); expect(response.data.message).toMatch(/merge driver/); expect(existsSync(reserved.executionPath)).toBe(false);
});
it.each(['merge', '-merge'])('모든 경로의 %s가 default custom driver를 선택하지 않으면 허용한다', async attribute => {
  targetAttributes(`* ${attribute}\n`); writeFileSync(join(work.executionPath!, '.gitattributes'), `* ${attribute}\n`); await result(); git(source, 'config', '--local', 'merge.default', 'custom'); git(source, 'config', '--local', 'merge.custom.driver', 'echo unused');
  const response = await api(`${reserved.candidateId}/prepare`, await prepare()); expect(response.data.status).toBe('validating');
});
it.each(['merge=text', 'merge=binary', 'merge=union', 'merge', '-merge', '!merge'])('custom 정의가 선택되지 않는 %s builtin 속성은 허용한다', async attribute => {
  targetAttributes(`code.txt ${attribute}\n`); await result(); git(source, 'config', '--local', 'merge.unused.driver', 'echo unused');
  const response = await api(`${reserved.candidateId}/prepare`, await prepare()); expect(response.data.status).toBe('validating');
});
it('정의 없는 driver 이름은 Git의 builtin text fallback을 허용한다', async () => {
  targetAttributes('code.txt merge=undefined-local-driver\n'); await result(); git(source, 'config', '--local', 'merge.default', 'undefined-default-driver');
  const response = await api(`${reserved.candidateId}/prepare`, await prepare()); expect(response.data.status).toBe('validating');
});
it.each(['merge', '-merge', '!merge'])('강제 builtin %s는 선택하지 않는 같은 이름의 custom 정의를 실행하지 않는다', async attribute => {
  targetAttributes(`code.txt ${attribute}\n`); await result();
  git(source, 'config', '--local', 'merge.text.driver', 'echo unused'); git(source, 'config', '--local', 'merge.binary.driver', 'echo unused');
  const response = await api(`${reserved.candidateId}/prepare`, await prepare()); expect(response.data.status).toBe('validating');
});
it('결과 뒤 추가 index·assume-unchanged는 후보 준비 대상으로 채택하지 않는다', async () => {
  await result(); writeFileSync(join(work.executionPath!, '.env'), 'secret'); git(work.executionPath!, 'add', '--', '.env');
  expect((await api(`${reserved.candidateId}/preview`)).status).toBe(409);
  git(work.executionPath!, 'reset', '--', '.env'); git(work.executionPath!, 'update-index', '--assume-unchanged', '--', 'code.txt');
  expect((await api(`${reserved.candidateId}/preview`)).status).toBe(409); expect(existsSync(reserved.executionPath)).toBe(false);
});
it('병합 도중 대상 이동은 후보를 성공·충돌로 공개하지 않는다', async () => {
  await result(true, 'target.txt'); const input = await prepare(), actual = runner.runGit; let moved = false;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => { const output = await actual(root, args, options, optional); if (args.includes('merge') && args.includes('--no-commit') && !moved) { moved = true; git(source, 'commit', '--allow-empty', '-m', 'external move'); } return output; });
  const response = await api(`${reserved.candidateId}/prepare`, input); expect(['failed', 'uncertain']).toContain(response.data.status); expect(response.data.candidateCommit).toBeNull(); expect(git(work.executionPath!, 'rev-parse', 'HEAD')).toBe(reserved.resultCommit);
});
it('재시작 후 동등한 외부 커밋이나 변조 identity는 성공 근거로 채택하지 않는다', async () => {
  await result(true, 'target.txt'); const input = await prepare(), response = await api(`${reserved.candidateId}/prepare`, input); expect(response.data.status).toBe('validating');
  const marker = join(reserved.executionPath, '..', 'identity.json'); writeFileSync(marker, readFileSync(marker, 'utf8').replace('"workId":"a"', '"workId":"foreign"'));
  await app.close(); app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  expect((await api(`${reserved.candidateId}/prepare`, input)).data.status).toBe('uncertain');
});
it('생성된 후보가 있는 실패 요청은 다른 키로 자동 생성하지 않는다', async () => {
  await result(); const input = await prepare(), actual = runner.runGit; let writes = 0;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => { if (args.includes('read-tree')) { writes++; throw new runner.GitError('fixture checkout failure'); } return actual(root, args, options, optional); });
  const response = await api(`${reserved.candidateId}/prepare`, input); expect(response.data.status).toBe('failed'); expect(existsSync(reserved.executionPath)).toBe(true);
  expect((await api(`${reserved.candidateId}/prepare`, { ...input, requestKey: 'different' })).status).toBe(409); expect(writes).toBe(1);
});
it('종료 미확인 프로세스는 lifecycle·영속 scope를 유지하고 자동 재실행하지 않는다', async () => {
  await result(); const input = await prepare(), actual = runner.runGit; let creates = 0;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => { if (args.includes('worktree') && args.includes('add')) { creates++; await options?.onSpawn?.(process.pid); throw new runner.GitError('termination unknown', 409, true, true); } return actual(root, args, options, optional); });
  const response = await api(`${reserved.candidateId}/prepare`, input); expect(response.data.status).toBe('uncertain'); expect(app.get(DesktopLifecycle).requests).toBe(1);
  expect(store.records('a', 'workspace-git-intent').some(row => row.scope === 'management' && row.status === 'uncertain' && row.terminationUnconfirmed)).toBe(true);
  expect((await api(`${reserved.candidateId}/prepare`, input)).data.status).toBe('uncertain'); expect(creates).toBe(1);
});
