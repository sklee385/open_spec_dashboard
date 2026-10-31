import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/app';
import { WorkStore, type Work } from '../src/work/store';
import { WorkService } from '../src/work/work.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorktreeManager } from '../src/work/worktree-manager';
import { collectWorkspaceDocuments } from '../src/work/workspace-documents';
import { IntegrationService } from '../src/work/integration.service';
import { projectCoordinator } from '../src/projects/coordinator';
import { DesktopLifecycle } from '../src/desktop/lifecycle';
import * as gitRunner from '../src/projects/git-runner';
import { createHash } from 'node:crypto';
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let app: any, base: string, root: string, source: string, store: WorkStore, settings: WorkspaceSettingsService, works: WorkService, a: Work, body: any;
const request = async (id: string, input?: any) => { const response = await fetch(`${base}/api/work/${id}/integration`, { method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); return { status: response.status, data: await response.json() }; };
function select(path: string) { const current = settings.read(), check = settings.check({ version: current.version, path }); settings.save({ version: current.version, token: check.token, confirmed: true }); }
async function fixture(id: string) {
  const work: Work = { id, sourceId: 'demo', projectPath: source, changeName: id, requestKey: id, ideaIds: [], phase: 'verification', state: 'idle', threadId: `thread-${id}`, reviewedVersion: 'plan', createdAt: '', updatedAt: '' }; store.save(work);
  const head = git(source, 'rev-parse', 'HEAD'); await new WorktreeManager({ store }).create(work, settings, { requestKey: `create-${id}`, selectedBranch: 'main', sourceHead: head, baseCommit: head });
  work.workspace!.status = 'ready'; work.workspace!.workspaceBaselineCommit = head; work.workspace!.sourcePlanRevision = collectWorkspaceDocuments(source, id).planRevision; store.save(work);
  work.reviewedVersion = works.planVersion(work); store.save(work);
  const command = { id: 'fixture', command: 'fixture-command', args: [] }; work.verificationCommands = [command]; store.save(work);
  store.record(`verified-${id}`, id, 'verification', { commandId: command.id, scope: 'full', status: 'passed', revision: works.execution.revision(work), sourceMutationVersion: work.sourceMutationVersion, commandVersion: JSON.stringify(command), evidenceVersion: 1, processTerminated: true, terminationEvidence: 'job-and-worker-closed', contextVersion: works.execution.verificationContext(work, command) });
  return work;
}
const input = (work: Work, key = 'integrate') => ({ requestKey: key, confirmed: true, targetBranch: 'main', expectedWorkHead: git(work.executionPath!, 'rev-parse', 'HEAD'), expectedTargetHead: git(source, 'rev-parse', 'main'), reviewedVersion: work.reviewedVersion });
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'i-')); source = join(root, 's'); mkdirSync(source); mkdirSync(join(root, 'c'));
  git(source, 'init', '-b', 'main'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test'); git(source, 'config', 'core.longpaths', 'true');
  for (const id of ['a', 'b']) { const docs = join(source, 'openspec/changes', id); mkdirSync(join(docs, 'specs/demo'), { recursive: true }); for (const path of ['proposal.md', 'design.md', 'tasks.md', 'specs/demo/spec.md']) writeFileSync(join(docs, path), '# Plan\n'); }
  writeFileSync(join(source, 'code.txt'), 'base'); git(source, 'add', '--all'); git(source, 'commit', '-m', 'fixture');
  process.env.CONFIG_PATH = join(root, 'c/config.json'); process.env.DATA_DIR = join(root, 'd'); delete process.env.WORKSPACE_ROOT; delete process.env.OPENSPEC_WORKTREE_EXPERIMENTAL;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: ['demo', 'other'].map(name => ({ name, path: join(source, 'openspec') })) }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl(); store = app.get(WorkStore); settings = app.get(WorkspaceSettingsService); works = app.get(WorkService);
  select(join(root, 'r')); a = await fixture('a'); body = input(a);
});
afterEach(async () => { await app?.close(); for (const key of ['CONFIG_PATH', 'DATA_DIR', 'OPENSPEC_WORKTREE_EXPERIMENTAL']) delete process.env[key]; vi.restoreAllMocks(); });
const api = async (path: string, input?: any) => { const response = await fetch(`${base}/api/work/a/integration/${path}`, { method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); return { status: response.status, data: await response.json() }; };
function verified() { const command = works.execution.commands(a)[0]; store.record('verified-a', 'a', 'verification', { commandId: command.id, scope: 'full', status: 'passed', revision: works.execution.revision(a), sourceMutationVersion: a.sourceMutationVersion, commandVersion: JSON.stringify(command), evidenceVersion: 1, processTerminated: true, terminationEvidence: 'job-and-worker-closed', contextVersion: works.execution.verificationContext(a, command) }); }
async function preview() { verified(); const reserved = await request('a', body); expect(reserved.status).toBe(200); const view = await api('commit-preview'); expect(view.status).toBe(200); return { integrationId: reserved.data.id, requestKey: 'result', confirmed: true, previewVersion: view.data.version, paths: view.data.entries.filter((x: any) => x.selectable).map((x: any) => x.path), message: '선택한 업무 결과 반영' }; }
it('선택한 전체 파일과 untracked를 정확히 커밋하고 원본·예약 기준을 보존한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); writeFileSync(join(a.executionPath!, '한글 [x].txt'), 'new');
  const original = git(source, 'rev-parse', 'HEAD'), input = await preview(); const result = await api('result-commit', input);
  expect(result.status).toBe(200); expect(result.data).toMatchObject({ status: 'committed' }); expect(git(source, 'rev-parse', 'HEAD')).toBe(original);
  expect(git(a.executionPath!, 'show', 'HEAD:code.txt')).toBe('changed'); expect(git(a.executionPath!, 'diff-tree', '-z', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\0').filter(Boolean).sort()).toEqual(['code.txt', '한글 [x].txt'].sort());
  const reserved = store.integrationRequests()[0]; expect(reserved.workHead).toBe(body.expectedWorkHead); expect(reserved.resultCommit).toBe(result.data.commit);
  expect(await api('result-commit', input)).toEqual(result); expect((await api('result-commit', { ...input, message: '다름' })).status).toBe(409);
});
it('미선택 소스와 선택 밖 staged 파일을 거부한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); writeFileSync(join(a.executionPath!, 'other.txt'), 'other'); const input = await preview();
  expect((await api('result-commit', { ...input, paths: ['code.txt'] })).status).toBe(409); git(a.executionPath!, 'add', '--', 'other.txt');
  const view = await api('commit-preview'); expect((await api('result-commit', { ...input, previewVersion: view.data.version, paths: ['code.txt'] })).status).toBe(409); expect(git(a.executionPath!, 'rev-parse', 'HEAD')).toBe(body.expectedWorkHead);
});
it('부분 stage는 파일 전체 스테이징 안내와 함께 거부한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'staged'); git(a.executionPath!, 'add', '--', 'code.txt'); writeFileSync(join(a.executionPath!, 'code.txt'), 'unstaged'); const input = await preview();
  const response = await api('result-commit', input); expect(response.status).toBe(409); expect(response.data.message).toMatch(/파일 전체 스테이징/); expect(git(a.executionPath!, 'show', ':code.txt')).toBe('staged');
});
it('미리보기 이후 파일 또는 index 변경은 커밋 전에 차단한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const input = await preview(); writeFileSync(join(a.executionPath!, 'code.txt'), 'later');
  expect((await api('result-commit', input)).status).toBe(409); expect(git(a.executionPath!, 'rev-parse', 'HEAD')).toBe(body.expectedWorkHead);
});
it('Windows autocrlf와 text eol 정규화를 지원하되 clean 필터는 실행하지 않는다', async () => {
  git(a.executionPath!, 'config', 'core.autocrlf', 'true'); writeFileSync(join(a.executionPath!, '.gitattributes'), '*.txt text eol=lf\n'); writeFileSync(join(a.executionPath!, 'code.txt'), 'hello\r\nworld\r\n');
  const input = await preview(), response = await api('result-commit', input); expect(response.status).toBe(200); expect(execFileSync('git', ['show', 'HEAD:code.txt'], { cwd: a.executionPath! }).toString()).toBe('hello\nworld\n');
});
it('삭제·rename·선행 공백 파일의 실제 tree를 보존한다', async () => {
  renameSync(join(a.executionPath!, 'code.txt'), join(a.executionPath!, ' renamed.txt')); writeFileSync(join(a.executionPath!, 'remove.txt'), 'remove'); git(a.executionPath!, 'add', '--', 'remove.txt'); git(a.executionPath!, 'commit', '-m', 'fixture deletion basis'); body = input(a); unlinkSync(join(a.executionPath!, 'remove.txt'));
  const inputBody = await preview(), response = await api('result-commit', inputBody); expect(response.data).toMatchObject({ status: 'committed' }); expect(execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], { cwd: a.executionPath! }).toString().split('\0')).toContain(' renamed.txt'); expect(git(a.executionPath!, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('remove.txt');
});
it('고정 로컬 자원과 비밀은 선택과 커밋에서 제외한다', async () => {
  a.workspace!.localOnlyPaths = ['resources']; a.workspace!.preparationPolicyDigest = 'reviewed-policy'; store.save(a); store.record('policy', 'a', 'workspace-local-policy', { policyDigest: 'reviewed-policy', confirmed: true, paths: ['resources'], generatedPaths: [] }); store.record('preparation', 'a', 'workspace-local-preparation', { policyDigest: 'reviewed-policy', status: 'ready' }); mkdirSync(join(a.executionPath!, 'resources')); writeFileSync(join(a.executionPath!, 'resources/local.txt'), 'local'); writeFileSync(join(a.executionPath!, '.env'), 'SECRET=fixture'); writeFileSync(join(a.executionPath!, 'code.txt'), 'changed');
  const inputBody = await preview(), response = await api('result-commit', inputBody); expect(inputBody.paths).toEqual(['code.txt']); expect(response.data).toMatchObject({ status: 'committed' }); expect(git(a.executionPath!, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toMatch(/\.env|resources/); expect(readFileSync(join(a.executionPath!, '.env'), 'utf8')).toBe('SECRET=fixture');
});
it('빈 선택은 현재 HEAD를 noop으로 확인하며 소스가 있으면 허용하지 않는다', async () => {
  const inputBody = await preview(), response = await api('result-commit', inputBody); expect(response.data).toMatchObject({ status: 'noop', commit: body.expectedWorkHead }); expect(await api('result-commit', inputBody)).toEqual(response);
});
it('HEAD·명령 또는 계획이 바뀌면 미리보기 토큰을 재사용하지 않는다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(); git(a.executionPath!, 'commit', '--allow-empty', '-m', 'external'); expect((await api('result-commit', inputBody)).status).toBe(409);
  expect(store.records('a', 'integration-result-commit')).toHaveLength(0);
});
it('영속 intent는 별도 WorkStore의 같은 업무를 차단하고 독립 B와 lifecycle 소유를 보존한다', async () => {
  const b = await fixture('b'); writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(), actual = gitRunner.runGit, other = new WorkStore(); let inspected = false;
  vi.spyOn(gitRunner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    if (args.includes('add') && args.some(arg => arg.startsWith('--pathspec-from-file='))) {
      inspected = true; expect(other.records('a', 'workspace-git-intent').at(-1)).toMatchObject({ status: 'running', scope: 'index' }); expect(() => projectCoordinator(other).assertWorkCanStart(other.get('a')!)).toThrow(/Git|미확인/); expect(() => projectCoordinator(other).assertWorkCanStart(b)).not.toThrow(); expect(app.get(DesktopLifecycle).requests).toBe(1);
    }
    return actual(root, args, options, optional);
  });
  try { const response = await api('result-commit', inputBody); expect(response.data).toMatchObject({ status: 'committed' }); expect(inspected).toBe(true); expect(app.get(DesktopLifecycle).requests).toBe(0); } finally { other.onApplicationShutdown(); }
});
it('실제 종료된 stage 실패는 failed로 남기고 새 명시 요청을 허용한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(), actual = gitRunner.runGit;
  const spy = vi.spyOn(gitRunner, 'runGit').mockImplementation(async (root, args, options, optional) => { if (args.includes('add')) throw new gitRunner.GitError('fixture stage failure'); return actual(root, args, options, optional); });
  const failed = await api('result-commit', inputBody); expect(failed.data).toMatchObject({ status: 'failed' }); spy.mockRestore(); expect(() => projectCoordinator(store).assertWorkCanStart(a)).not.toThrow(); const view = await api('commit-preview'); const response = await api('result-commit', { ...inputBody, requestKey: 'after-failure', previewVersion: view.data.version }); expect(response.data).toMatchObject({ status: 'committed' });
});
it('write-tree 전에 들어온 선택 밖 stage는 tree 비교로 차단한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(), actual = gitRunner.runGit; let injected = false;
  vi.spyOn(gitRunner, 'runGit').mockImplementation(async (root, args, options, optional) => { if (args.includes('write-tree') && !injected) { injected = true; writeFileSync(join(root, 'outside.txt'), 'external'); git(root, 'add', '--', 'outside.txt'); } return actual(root, args, options, optional); });
  const response = await api('result-commit', inputBody); expect(response.data).toMatchObject({ status: 'failed' }); expect(git(a.executionPath!, 'rev-parse', 'HEAD')).toBe(body.expectedWorkHead); expect(git(a.executionPath!, 'show', ':outside.txt')).toBe('external');
});
it('검증 tree 뒤 index가 바뀌어도 선택한 immutable tree만 커밋한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(), actual = gitRunner.runGit;
  vi.spyOn(gitRunner, 'runGit').mockImplementation(async (root, args, options, optional) => { if (args.includes('commit-tree')) { const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'external', encoding: 'utf8' }).trim(); git(root, 'update-index', '--add', '--cacheinfo', `100644,${oid},outside.txt`); } return actual(root, args, options, optional); });
  const response = await api('result-commit', inputBody); expect(response.data).toMatchObject({ status: 'committed' }); expect(git(a.executionPath!, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('outside.txt'); expect(git(a.executionPath!, 'show', ':outside.txt')).toBe('external');
});
it('ref CAS 뒤 기록 실패는 재시작 후 실제 부모·tree와 정확한 메시지로 복구한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = { ...await preview(), message: '메시지 공백  \n\n\n끝\n' }, record = store.record.bind(store); let failed = false;
  vi.spyOn(store, 'record').mockImplementation((id, workId, kind, data: any) => { if (!failed && kind === 'integration-result-commit' && data.status === 'committed') { failed = true; throw new Error('fixture persistence failure'); } return record(id, workId, kind, data); });
  const response = await api('result-commit', inputBody); expect(response.data).toMatchObject({ status: 'uncertain' }); const head = git(a.executionPath!, 'rev-parse', 'HEAD'); expect(head).not.toBe(body.expectedWorkHead);
  await app.close(); app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl(); store = app.get(WorkStore); const recovered = await api('result-commit', inputBody); expect(recovered.data).toMatchObject({ status: 'committed', commit: head }); expect(git(a.executionPath!, 'rev-parse', 'HEAD')).toBe(head);
});
it('정리할 호스트 임시 경로가 사라져도 lifecycle과 메모리 잠금을 해제한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(), actual = gitRunner.runGit; let directory = '';
  vi.spyOn(gitRunner, 'runGit').mockImplementation(async (root, args, options, optional) => { const spec = args.find(arg => arg.startsWith('--pathspec-from-file=')); if (spec) directory = spec.slice('--pathspec-from-file='.length).replace(/[\\/]paths\.nul$/, ''); const output = await actual(root, args, options, optional); if (args.includes('update-ref')) { expect(directory.startsWith(process.env.DATA_DIR!)).toBe(true); unlinkSync(join(directory, 'paths.nul')); rmdirSync(directory); } return output; });
  const response = await api('result-commit', inputBody); expect(response.data).toMatchObject({ status: 'committed', cleanupWarning: expect.any(String) }); expect(app.get(DesktopLifecycle).requests).toBe(0); expect(() => projectCoordinator(store).assertWorkCanStart(store.get('a')!)).not.toThrow();
});
it('필터·인코딩 변환이 있는 파일은 커밋 preview 전에 차단한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(); writeFileSync(join(a.executionPath!, '.gitattributes'), 'code.txt filter=custom\n'); git(a.executionPath!, 'config', 'filter.custom.clean', 'echo wrong');
  const response = await api('result-commit', inputBody); expect(response.status).toBe(409); expect(response.data.message).toMatch(/필터/); expect(git(a.executionPath!, 'rev-parse', 'HEAD')).toBe(body.expectedWorkHead);
});
it('별도 연결의 같은 키 예약에 패한 요청은 승자의 기록과 intent를 덮어쓰지 않는다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(), other = new WorkStore(), transaction = store.transaction.bind(store), hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'), id = `result-commit:${hash(['a', inputBody.requestKey])}`;
  const winner = { id, fingerprint: hash({ ...inputBody, paths: [...inputBody.paths].sort() }), status: 'running', processId: 12345, marker: 'winner' }, intent = { scope: 'index', root: a.executionPath, commonDir: a.workspace!.commonDir, refs: [`refs/heads/${a.workspace!.branch}`], affectedRoots: [a.executionPath], status: 'running', processId: 12345 };
  let injected = false; vi.spyOn(store, 'transaction').mockImplementation((operation: any) => { if (!injected) { injected = true; other.record(id, 'a', 'integration-result-commit', winner); other.record(`${id}:git`, 'a', 'workspace-git-intent', intent); const directory = join(process.env.DATA_DIR!, readdirSync(process.env.DATA_DIR!).find(name => name.startsWith('result-commit-'))!); unlinkSync(join(directory, 'paths.nul')); rmdirSync(directory); } return transaction(operation); });
  try { const response = await api('result-commit', inputBody); expect(response.status).toBe(409); expect(other.records('a', 'integration-result-commit')[0]).toEqual(winner); expect(other.records('a', 'workspace-git-intent').at(-1)).toMatchObject(intent); expect(app.get(DesktopLifecycle).requests).toBe(0); } finally { other.onApplicationShutdown(); }
});
it('8MiB 초과 파일은 stage 전에 명확히 차단한다', async () => {
  writeFileSync(join(a.executionPath!, 'large.bin'), Buffer.alloc(8 * 1024 * 1024 + 1, 1)); const inputBody = await preview(); const response = await api('result-commit', inputBody); expect(response.status).toBe(409); expect(response.data.message).toMatch(/8 MiB/); expect(git(a.executionPath!, 'diff', '--cached', '--name-only')).toBe('');
});
it('저장한 OID와 다른 외부 등가 커밋을 재조회 성공으로 채택하지 않는다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(), response = await api('result-commit', inputBody); expect(response.data).toMatchObject({ status: 'committed' });
  const replacement = execFileSync('git', ['commit-tree', response.data.tree, '-p', body.expectedWorkHead, '-m', inputBody.message], { cwd: a.executionPath!, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' } }).trim(); expect(replacement).not.toBe(response.data.commit); git(a.executionPath!, 'update-ref', `refs/heads/${a.workspace!.branch}`, replacement, response.data.commit);
  const replay = await api('result-commit', inputBody); expect(replay.data.status).toBe('uncertain'); expect(store.integrationRequests()[0].resultCommit).toBe(response.data.commit);
});
it('종료 불명 Git은 durable scope와 lifecycle 소유를 유지하고 독립 B는 허용한다', async () => {
  const b = await fixture('b'); writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(), actual = gitRunner.runGit;
  vi.spyOn(gitRunner, 'runGit').mockImplementation(async (root, args, options, optional) => { if (args.includes('add')) { await options?.onSpawn?.(process.pid); throw new gitRunner.GitError('fixture termination unknown', 409, true, true); } return actual(root, args, options, optional); });
  const response = await api('result-commit', inputBody); expect(response.data.status).toBe('uncertain'); expect(store.records('a', 'workspace-git-intent').at(-1)).toMatchObject({ status: 'uncertain', terminationUnconfirmed: true }); expect(app.get(DesktopLifecycle).requests).toBe(1); expect(() => projectCoordinator(store).assertWorkCanStart(a)).toThrow(); expect(() => projectCoordinator(store).assertWorkCanStart(b)).not.toThrow();
});
it('ignore와 assume-unchanged로 숨긴 검증 소스는 선택 누락을 허용하지 않는다', async () => {
  writeFileSync(join(a.executionPath!, '.gitignore'), 'hidden.txt\n'); writeFileSync(join(a.executionPath!, 'hidden.txt'), 'hidden source'); verified(); expect((await request('a', body)).status).toBe(200); const ignored = await api('commit-preview'); expect(ignored.status).toBe(409); expect(ignored.data.message).toMatch(/표시되지 않는 검증 소스/);
  unlinkSync(join(a.executionPath!, 'hidden.txt')); unlinkSync(join(a.executionPath!, '.gitignore')); git(a.executionPath!, 'update-index', '--assume-unchanged', '--', 'code.txt'); writeFileSync(join(a.executionPath!, 'code.txt'), 'hidden change'); verified(); const flags = await api('commit-preview'); expect(flags.status).toBe(409); expect(flags.data.message).toMatch(/assume-unchanged/); expect(git(a.executionPath!, 'rev-parse', 'HEAD')).toBe(body.expectedWorkHead);
  git(a.executionPath!, 'update-index', '--no-assume-unchanged', '--', 'code.txt'); verified(); git(a.executionPath!, 'update-index', '--skip-worktree', '--', 'code.txt'); expect(git(a.executionPath!, 'ls-files', '-v', '--', 'code.txt')).toBe('S code.txt'); expect((await api('commit-preview')).status).toBe(409);
});
it('재시작 복구는 업무 identity가 변조되면 성공을 채택하지 않는다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(), response = await api('result-commit', inputBody); expect(response.data.status).toBe('committed'); const marker = join(a.executionPath!, '..', 'identity.json'); writeFileSync(marker, readFileSync(marker, 'utf8').replace('"workId":"a"', '"workId":"foreign"'));
  const replay = await api('result-commit', inputBody); expect(replay.data.status).toBe('uncertain'); expect(replay.data.error).toMatch(/identity/);
});
it('commit-tree 도중 소스가 바뀌면 ref CAS 전에 차단한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(), actual = gitRunner.runGit;
  vi.spyOn(gitRunner, 'runGit').mockImplementation(async (root, args, options, optional) => { const output = await actual(root, args, options, optional); if (args.includes('commit-tree')) writeFileSync(join(root, 'code.txt'), 'later'); return output; });
  const response = await api('result-commit', inputBody); expect(response.data.status).toBe('failed'); expect(git(a.executionPath!, 'rev-parse', 'HEAD')).toBe(body.expectedWorkHead); expect(store.integrationRequests()[0].resultCommit).toBeUndefined();
});
it('noop 기록 실패는 부분 attach 없이 새 명시 요청으로 복구할 수 있다', async () => {
  const inputBody = await preview(), record = store.record.bind(store); let failed = false;
  const spy = vi.spyOn(store, 'record').mockImplementation((id, workId, kind, data: any) => { if (!failed && kind === 'integration-result-commit' && data.status === 'noop') { failed = true; throw new Error('fixture noop persistence failure'); } return record(id, workId, kind, data); });
  const response = await api('result-commit', inputBody); expect(response.data.status).toBe('failed'); expect(store.integrationRequests()[0].resultCommit).toBeUndefined(); spy.mockRestore(); const view = await api('commit-preview'); const retry = await api('result-commit', { ...inputBody, requestKey: 'noop-retry', previewVersion: view.data.version }); expect(retry.data.status).toBe('noop');
});
it('Windows argv 한도를 넘는 250개 전체 파일도 소유 NUL pathspec으로 stage한다', async () => {
  for (let n = 0; n < 250; n++) writeFileSync(join(a.executionPath!, `${n}-${'x'.repeat(160)}.txt`), `source ${n}`);
  const inputBody = await preview(), actual = gitRunner.runGit; let saw = false;
  vi.spyOn(gitRunner, 'runGit').mockImplementation(async (root, args, options, optional) => { if (args.includes('add')) { saw = true; expect(args.join(' ').length).toBeLessThan(2000); const path = args.find(arg => arg.startsWith('--pathspec-from-file='))!.slice('--pathspec-from-file='.length); expect(readFileSync(path).toString().split('\0').filter(Boolean)).toHaveLength(250); expect(args).toContain('--pathspec-file-nul'); } return actual(root, args, options, optional); });
  const response = await api('result-commit', inputBody); expect(response.data.status).toBe('committed'); expect(saw).toBe(true); expect(execFileSync('git', ['diff-tree', '-z', '--no-commit-id', '--name-only', '-r', 'HEAD'], { cwd: a.executionPath! }).toString().split('\0').filter(Boolean)).toHaveLength(250);
});
it('추적 중인 비공개 파일의 clean 속성도 status 실행 전에 차단한다', async () => {
  writeFileSync(join(a.executionPath!, '.env'), 'SECRET=fixture'); git(a.executionPath!, 'add', '--', '.env'); git(a.executionPath!, 'commit', '-m', 'tracked private fixture'); body = input(a); writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); await preview();
  writeFileSync(join(a.executionPath!, '.gitattributes'), '.env filter=custom\n'); git(a.executionPath!, 'config', 'filter.custom.clean', 'echo wrong'); const actual = gitRunner.runGit; let status = false;
  vi.spyOn(gitRunner, 'runGit').mockImplementation(async (root, args, options, optional) => { if (args.includes('status')) status = true; return actual(root, args, options, optional); });
  const view = await api('commit-preview'); expect(view.status).toBe(409); expect(view.data.message).toMatch(/필터/); expect(status).toBe(false);
});
it('CAS 성공 뒤 Git 조회 오류는 uncertain으로 남기고 실제 재조회로 복구한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(), actual = gitRunner.runGit; let applied = false, failed = false;
  vi.spyOn(gitRunner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    if (applied && !failed && args.includes('rev-parse')) { failed = true; throw new gitRunner.GitError('fixture post-CAS query failure'); }
    const output = await actual(root, args, options, optional); if (args.includes('update-ref')) applied = true; return output;
  });
  const response = await api('result-commit', inputBody); expect(response.data).toMatchObject({ status: 'uncertain', refUpdateCompleted: true }); expect(app.get(DesktopLifecycle).requests).toBe(0); const head = git(a.executionPath!, 'rev-parse', 'HEAD'); expect(head).toBe(response.data.commitObject);
  const replay = await api('result-commit', inputBody); expect(replay.data).toMatchObject({ status: 'committed', commit: head }); expect(store.integrationRequests()[0].resultCommit).toBe(head); expect(store.records('a', 'workspace-git-intent').at(-1)?.status).toBe('passed');
});
it('실제 ref CAS 거절은 failed로 남기고 새 명시 요청으로 재시도한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const inputBody = await preview(), actual = gitRunner.runGit;
  const spy = vi.spyOn(gitRunner, 'runGit').mockImplementation(async (root, args, options, optional) => { if (args.includes('update-ref')) throw new gitRunner.GitError('fixture CAS rejection'); return actual(root, args, options, optional); });
  const response = await api('result-commit', inputBody); expect(response.data.status).toBe('failed'); expect(git(a.executionPath!, 'rev-parse', 'HEAD')).toBe(body.expectedWorkHead); expect(() => projectCoordinator(store).assertWorkCanStart(a)).not.toThrow(); spy.mockRestore(); const view = await api('commit-preview'); const retry = await api('result-commit', { ...inputBody, requestKey: 'cas-retry', previewVersion: view.data.version }); expect(retry.data.status).toBe('committed');
});
it('JSON 키와 paths 순서만 달라진 같은 요청은 동일한 결과를 재조회한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); writeFileSync(join(a.executionPath!, 'other.txt'), 'new'); const inputBody = await preview(), response = await api('result-commit', inputBody); expect(response.data.status).toBe('committed');
  const reordered = Object.fromEntries(Object.entries({ ...inputBody, paths: [...inputBody.paths].reverse() }).reverse()); const replay = await api('result-commit', reordered); expect(replay).toEqual(response); expect(store.records('a', 'integration-result-commit')).toHaveLength(1);
});
it('결과 commit stale 거부 marker는 business intent 전만 반환한다', async () => {
  writeFileSync(join(a.executionPath!, 'code.txt'), 'changed'); const input = { ...await preview(), requestKey: 'result-stale', previewVersion: '0'.repeat(64) };
  const rejected = await api('result-commit', input); expect(rejected).toMatchObject({ status: 409, data: { mutationOutcome: 'rejected-before-intent', requestKey: input.requestKey } });
  expect(store.records('a', 'integration-result-commit')).toEqual([]); expect(git(a.executionPath!, 'rev-parse', 'HEAD')).toBe(body.expectedWorkHead);
  const changed = await api('result-commit', { ...input, message: 'different body' }); expect(changed.status).toBe(409); expect(changed.data).not.toHaveProperty('mutationOutcome');
});
