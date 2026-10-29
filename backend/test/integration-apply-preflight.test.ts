import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, utimesSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { candidateIdentity } from '../src/work/integration-candidate';
import { IntegrationApplyPreflight } from '../src/work/integration-apply-preflight';
import { IntegrationEditing } from '../src/work/integration-editing';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/app';
import { WorkStore, type Work } from '../src/work/store';
import { WorkService } from '../src/work/work.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorktreeManager } from '../src/work/worktree-manager';
import { collectWorkspaceDocuments } from '../src/work/workspace-documents';
import { projectCoordinator } from '../src/projects/coordinator';
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let app: any, base: string, source: string, store: WorkStore, work: Work, works: WorkService, reserved: any;
const savedEnv = { CONFIG_PATH: process.env.CONFIG_PATH, DATA_DIR: process.env.DATA_DIR, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
async function api(path: string, body?: unknown) { const r = await fetch(`${base}/api/work/a/integration/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; }
function verified() { const command = works.execution.commands(work)[0]; store.record('verified', 'a', 'verification', { commandId: command.id, scope: 'full', status: 'passed', revision: works.execution.revision(work), sourceMutationVersion: work.sourceMutationVersion, commandVersion: JSON.stringify(command) }); }
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p-')); source = join(dir, 's'); mkdirSync(source); mkdirSync(join(dir, 'c'));
  git(source, 'init', '-b', 'main'); git(source, 'config', 'core.autocrlf', 'false'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test');
  const docs = join(source, 'openspec/changes/a'); mkdirSync(join(docs, 'specs/demo'), { recursive: true });
  for (const path of ['proposal.md', 'design.md', 'tasks.md', 'specs/demo/spec.md']) writeFileSync(join(docs, path), '# Plan\n');
  writeFileSync(join(source, 'code.txt'), 'base\n');
  writeFileSync(join(source, 'bootstrap.cjs'), "require('fs').writeFileSync('bootstrap-before-job.txt','ran');");
  git(source, 'add', '--all'); git(source, 'commit', '-m', 'fixture');
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
// Real Git prepared seed: 5.2/5.3 command orchestration is covered by their suites.
// This fixture retains real registrations, identities, result parent and merge parents.
async function seed() {
  const initial = git(work.executionPath!, 'rev-parse', 'HEAD');
  writeFileSync(join(work.executionPath!, 'code.txt'), 'result\n'); git(work.executionPath!, 'add', '--', 'code.txt'); git(work.executionPath!, 'commit', '-m', 'result fixture');
  const resultCommit = git(work.executionPath!, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'target.txt'), 'target\n'); git(source, 'add', '--', 'target.txt'); git(source, 'commit', '-m', 'target fixture');
  const space = work.workspace!, candidateId = randomUUID(), container = join(space.managedPath, 'projects', space.projectId, 'integrations', candidateId), path = join(container, 'project');
  mkdirSync(container, { recursive: true });
  git(source, 'worktree', 'add', '-b', `codex/integration-${candidateId}`, '--', path, 'main'); git(path, 'merge', '--no-ff', '-m', 'candidate fixture', resultCommit);
  reserved = { ...space, id: 'integration-fixture', workId: 'a', requestKey: 'integrate', fingerprint: 'fixture', candidateId, executionPath: path, workExecutionPath: work.executionPath!, commonDir: space.commonDir!, projectPath: source, workspaceId: space.workspaceId, targetBranch: 'main', targetHead: git(source, 'rev-parse', 'HEAD'), workHead: initial, resultCommit, resultTree: git(work.executionPath!, 'rev-parse', 'HEAD^{tree}'), candidateCommit: git(path, 'rev-parse', 'HEAD'), reviewedVersion: work.reviewedVersion!, sourceRevision: works.execution.revision(work), workVerificationRefs: ['verified'], verificationRefs: [], conflicts: [], status: 'validating', createdAt: '', updatedAt: '' };
  writeFileSync(join(container, 'identity.json'), JSON.stringify(candidateIdentity(reserved)));
  store.record(reserved.id, 'a', 'integration-request', reserved);
  store.record('prepared-fixture', 'a', 'integration-preparation', { candidateId, status: 'validating', commit: reserved.candidateCommit });
  verified();
  expect(git(path, 'show', '-s', '--format=%P')).toBe(`${reserved.targetHead} ${resultCommit}`);
}

async function ready() {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  await certify();
}
async function certify() {
  // Verification command execution is covered by 6.1. Bind actual Git/policy proof here.
  const preview = await api(`${reserved.candidateId}/verification/preview`); expect(preview.status).toBe(200);
  store.record('candidate-pass', 'a', 'candidate-verification', { candidateId: reserved.candidateId, status: 'passed', processTerminated: true, candidateVersion: preview.data.candidateVersion });
}
function preserved() {
  return [source, work.executionPath!, reserved.executionPath].map(root => [git(root, 'rev-parse', 'HEAD'), readFileSync(git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).toString('base64'), git(root, 'status', '--porcelain=v1', '--untracked-files=all'), git(root, 'show-ref'),
    git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])]);
}
it('새 사전검사만 통과하고 Git과 적용 의도·기록을 변경하지 않는다', async () => {
  await ready(); const before = preserved(), records = store.integrationRequests(), intents = store.records('a', 'workspace-git-intent');
  const preview = await api(`${reserved.candidateId}/apply/preview`); expect(preview.status).toBe(200); expect(preview.data.applied).toBe(false);
  const confirmed = await api(`${reserved.candidateId}/apply/preflight`, { confirmed: true, expectedVersion: preview.data.expectedVersion });
  expect(confirmed.status).toBe(200); expect(confirmed.data).toMatchObject({ preflightPassed: true, applied: false });
  expect(preserved()).toEqual(before); expect(store.integrationRequests()).toEqual(records); expect(store.records('a', 'workspace-git-intent')).toEqual(intents);
});

it.each(['unstaged', 'staged', 'untracked', 'assume', 'skip'])('원본 비겹침 %s 변경도 정리 없이 차단한다', async changed => {
  await ready();
  if (changed === 'untracked') writeFileSync(join(source, 'unrelated.txt'), 'private');
  else if (changed === 'assume' || changed === 'skip') { git(source, 'update-index', changed === 'assume' ? '--assume-unchanged' : '--skip-worktree', 'bootstrap.cjs'); writeFileSync(join(source, 'bootstrap.cjs'), 'hidden local change'); }
  else { writeFileSync(join(source, 'target.txt'), 'unrelated local change'); if (changed === 'staged') git(source, 'add', '--', 'target.txt'); }
  await certify(); const before = preserved();
  const response = await api(`${reserved.candidateId}/apply/preview`); expect(response.status).toBe(409); expect(preserved()).toEqual(before);
});

it.each(['MERGE_HEAD', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'sequencer', 'rebase-merge', 'rebase-apply', 'index.lock', 'HEAD.lock'])('원본 진행·lock %s 표시를 삭제하지 않는다', async name => {
  await ready(); const dir = git(source, 'rev-parse', '--absolute-git-dir'), path = join(dir, name);
  if (['sequencer', 'rebase-merge', 'rebase-apply'].includes(name)) mkdirSync(path); else writeFileSync(path, reserved.targetHead);
  const response = await api(`${reserved.candidateId}/apply/preview`); expect(response.status).toBe(409); expect(existsSync(path)).toBe(true); expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.targetHead);
});

it.each(['head', 'branch', 'detached', 'files', 'index', 'verification', 'epoch', 'commands', 'registration'])('preview 이후 %s 변경은 명시 확인을 stale로 거부한다', async changed => {
  await ready(); const preview = await api(`${reserved.candidateId}/apply/preview`); expect(preview.status).toBe(200);
  if (changed === 'head') git(source, 'commit', '--allow-empty', '-m', 'moved');
  if (changed === 'branch') git(source, 'checkout', '-b', 'other');
  if (changed === 'detached') git(source, 'checkout', '--detach');
  if (changed === 'files') writeFileSync(join(source, 'unrelated.txt'), 'local');
  if (changed === 'index') { writeFileSync(join(source, 'target.txt'), 'staged'); git(source, 'add', '--', 'target.txt'); }
  if (changed === 'verification') store.record('new-failed', 'a', 'candidate-verification', { candidateId: reserved.candidateId, status: 'failed', processTerminated: true });
  if (changed === 'epoch') store.record(reserved.id, 'a', 'integration-request', { ...store.integrationRequests()[0], candidateMutationVersion: 'next' });
  if (changed === 'commands') { work.verificationCommands![0].args = ['-e', 'process.exit(1)']; store.save(work); }
  if (changed === 'registration') git(source, 'worktree', 'add', '-b', 'new-other', join(dirname(source), 'other'), 'main');
  const before = preserved(), response = await api(`${reserved.candidateId}/apply/preflight`, { confirmed: true, expectedVersion: preview.data.expectedVersion });
  expect(response.status).toBe(409); expect(response.data.mutationOutcome).toBeUndefined(); expect(preserved()).toEqual(before);
});

it('다른 등록 worktree에서 대상 branch를 checkout하면 원본을 전환하지 않는다', async () => {
  await ready(); const other = join(dirname(source), 'other'); git(source, 'worktree', 'add', '--force', other, 'main');
  const before = preserved(); expect((await api(`${reserved.candidateId}/apply/preview`)).status).toBe(409); expect(preserved()).toEqual(before);
});
it('무관 worktree HEAD만 변경해도 기존 사전검사 버전은 유지한다', async () => {
  await ready(); const other = join(dirname(source), 'other'); git(source, 'worktree', 'add', '-b', 'unrelated', other, 'main');
  const preview = await api(`${reserved.candidateId}/apply/preview`); expect(preview.status).toBe(200);
  git(other, 'commit', '--allow-empty', '-m', 'independent');
  const confirm = await api(`${reserved.candidateId}/apply/preflight`, { confirmed: true, expectedVersion: preview.data.expectedVersion }); expect(confirm.status).toBe(200);
});
it('활성·미확인 scope와 최신 후보가 아닌 검증은 차단한다', async () => {
  await ready(); const release = projectCoordinator(store).acquireOperation({ kind: 'workspace', root: source, commonDir: reserved.commonDir });
  try { expect((await api(`${reserved.candidateId}/apply/preview`)).status).toBe(409); } finally { release(); }
  store.record('unknown', 'a', 'workspace-git-intent', { scope: 'integration', root: source, commonDir: reserved.commonDir, status: 'uncertain' });
  expect((await api(`${reserved.candidateId}/apply/preview`)).status).toBe(409);
});
it('명시 확인·버전만 받고 임의 경로·대상·명령 입력을 거부한다', async () => {
  await ready();
  for (const body of [{ confirmed: false, expectedVersion: 'a'.repeat(64) }, { confirmed: true, expectedVersion: 'a'.repeat(64), path: source }, { confirmed: true, expectedVersion: 'a'.repeat(64), command: 'reset' }]) expect((await api(`${reserved.candidateId}/apply/preflight`, body)).status).toBe(400);
  expect((await api(`${reserved.candidateId}/apply/preview?path=other`)).status).toBe(400);
});
it.each(['candidate-files', 'work-files', 'identity', 'path', 'browser', 'not-run'])('%s 기준이 다르면 다른 후보 근거로 대체하지 않는다', async changed => {
  await ready();
  if (changed === 'candidate-files') writeFileSync(join(reserved.executionPath, 'code.txt'), 'candidate changed');
  if (changed === 'work-files') writeFileSync(join(work.executionPath!, 'code.txt'), 'work changed');
  if (changed === 'identity') writeFileSync(join(dirname(reserved.executionPath), 'identity.json'), '{}');
  if (changed === 'path') store.record(reserved.id, 'a', 'integration-request', { ...reserved, projectPath: dirname(source) });
  if (changed === 'browser') { work.browserScenario = { version: 1, steps: [] }; store.save(work); }
  if (changed === 'not-run') store.record('candidate-pass', 'a', 'candidate-verification', { candidateId: reserved.candidateId, status: 'blocked', processTerminated: true });
  expect((await api(`${reserved.candidateId}/apply/preview`)).status).toBe(changed === 'path' ? 404 : 409);
});
it('원본 실제 clean filter는 status 전에 차단하여 실행하지 않는다', async () => {
  await ready(); const marker = join(dirname(source), 'filter-ran');
  git(source, 'config', 'filter.danger.clean', `echo ran > ${marker.replaceAll('\\', '/')}`);
  writeFileSync(join(source, '.gitattributes'), 'code.txt filter=danger\n');
  await certify();
  const response = await api(`${reserved.candidateId}/apply/preview`); expect(response.status).toBe(409); expect(existsSync(marker)).toBe(false);
});
it('내부 ephemeral fence는 실행 snapshot에서 제외된 새 원본 untracked도 차단한다', async () => {
  await ready(); const proof = await app.get(IntegrationApplyPreflight).capture('a', reserved.candidateId);
  writeFileSync(join(source, '.env.local'), 'LOCAL_ONLY=private\n');
  expect(() => proof.assertUnchanged()).toThrow(/원본|변경/);
});
it('외부 attributesFile 변경도 내부 ephemeral fence를 무효화한다', async () => {
  await ready(); const external = join(dirname(source), 'global-attributes'); writeFileSync(external, '');
  git(source, 'config', 'core.attributesFile', external); await certify();
  const proof = await app.get(IntegrationApplyPreflight).capture('a', reserved.candidateId);
  writeFileSync(external, 'code.txt text eol=crlf\n');
  expect(() => proof.assertUnchanged()).toThrow(/원본|속성|변경/);
});
it('원본 guard 직후 속성 경쟁에도 clean helper를 실행하지 않는다', async () => {
  await ready(); const marker = join(dirname(source), 'race-filter-ran');
  git(source, 'config', 'filter.race.clean', `echo ran > '${marker.split(String.fromCharCode(92)).join('/')}'`); await certify();
  const editing = app.get(IntegrationEditing), guard = editing.assertRootGitRead.bind(editing); let changed = false;
  vi.spyOn(editing, 'assertRootGitRead').mockImplementation(async (root: string) => {
    const result = await guard(root);
    if (root === source && !changed) {
      changed = true; writeFileSync(join(source, '.gitattributes'), 'code.txt filter=race\n');
      const path = join(source, 'code.txt'), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
      const later = new Date(Date.now() + 2000); utimesSync(path, later, later);
    }
    return result;
  });
  const response = await api(`${reserved.candidateId}/apply/preview`);
  expect(changed).toBe(true); expect(response.status).toBe(409); expect(existsSync(marker)).toBe(false);
});
it('허용한 autocrlf 원본의 clean CRLF 바이트를 dirty로 오인하지 않는다', async () => {
  const path = join(source, 'line-ending.txt'); writeFileSync(path, 'line' + String.fromCharCode(10)); git(source, 'add', '--', 'line-ending.txt'); git(source, 'commit', '-m', 'LF fixture');
  await ready(); git(source, 'config', 'core.autocrlf', 'true');
  unlinkSync(path); git(source, 'checkout', '--', 'line-ending.txt');
  expect(readFileSync(path).toString('hex')).toBe('6c696e650d0a');
  const evidence = { head: execFileSync('git', ['show', 'HEAD:line-ending.txt'], { cwd: source, windowsHide: true }).toString('hex'), index: execFileSync('git', ['show', ':line-ending.txt'], { cwd: source, windowsHide: true }).toString('hex'), working: readFileSync(path).toString('hex'), attrs: git(source, 'check-attr', 'text', 'eol', 'filter', '--', 'line-ending.txt'), config: git(source, 'config', '--show-origin', '--get-all', 'core.autocrlf') };
  expect(git(source, 'status', '--porcelain=v1'), JSON.stringify(evidence)).toBe(''); await certify();
  expect((await api(`${reserved.candidateId}/apply/preview`)).status).toBe(200);
});
it('config 전환 뒤 Git이 dirty로 보는 CRLF 크기 변경은 정규화만으로 통과하지 않는다', async () => {
  const path = join(source, 'line-ending.txt'); writeFileSync(path, 'line' + String.fromCharCode(10)); git(source, 'add', '--', 'line-ending.txt'); git(source, 'commit', '-m', 'LF fixture');
  await ready(); git(source, 'config', 'core.autocrlf', 'true'); writeFileSync(path, 'line' + String.fromCharCode(13, 10));
  expect(git(source, 'status', '--porcelain=v1')).toContain('M line-ending.txt'); await certify();
  expect((await api(`${reserved.candidateId}/apply/preview`)).status).toBe(409);
});
it.each(['bare CR', 'controls'])('Git이 binary로 보는 %s은 정규화 blob 일치로 통과하지 않는다', async kind => {
  const prefix = kind === 'bare CR' ? 'one' + String.fromCharCode(13) + 'two' : String.fromCharCode(1).repeat(8) + 'line';
  const path = join(source, 'binary-rule.txt'); writeFileSync(path, prefix + String.fromCharCode(10)); git(source, 'add', '--', 'binary-rule.txt'); git(source, 'commit', '-m', 'binary text fixture');
  await ready(); git(source, 'config', 'core.autocrlf', 'true'); writeFileSync(path, prefix + String.fromCharCode(13, 10));
  const blob = git(source, 'rev-parse', 'HEAD:binary-rule.txt'); git(source, 'update-index', '--cacheinfo', `100644,${blob},binary-rule.txt`);
  expect(git(source, 'ls-files', '--debug', '--', 'binary-rule.txt')).toContain('size: 0');
  expect(git(source, 'status', '--porcelain=v1')).toContain('M binary-rule.txt'); await certify();
  expect((await api(`${reserved.candidateId}/apply/preview`)).status).toBe(409);
});
it.each(['false', 'true'])('snapshot은 core.filemode=%s 정책으로 mode를 읽고 diff를 실행하지 않는다', async value => {
  await ready(); git(work.executionPath!, 'update-index', '--chmod=+x', 'code.txt'); git(source, 'config', 'core.filemode', value);
  const snapshot = works.execution.snapshot(work), disk = (lstatSync(join(work.executionPath!, 'code.txt')).mode & 0o111) ? '100755' : '100644';
  expect(snapshot['code.txt'].mode).toBe(value === 'false' ? '100755' : disk);
});
it('snapshot의 index 조회는 fsmonitor hook을 실행하지 않는다', async () => {
  await ready(); const marker = join(dirname(source), 'fsmonitor-ran');
  git(source, 'config', 'core.fsmonitor', `echo ran > '${marker.split(String.fromCharCode(92)).join('/')}'`);
  expect(existsSync(marker)).toBe(false); works.execution.snapshot(work); expect(existsSync(marker)).toBe(false);
});
it('업무 snapshot의 mode 조회도 clean helper를 실행하지 않는다', async () => {
  const marker = join(dirname(source), 'work-filter-ran'); git(source, 'config', 'filter.work.clean', `echo ran > '${marker.split(String.fromCharCode(92)).join('/')}'`); await ready();
  writeFileSync(join(work.executionPath!, '.gitattributes'), 'code.txt filter=work' + String.fromCharCode(10));
  const path = join(work.executionPath!, 'code.txt'), bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes); const later = new Date(Date.now() + 2000); utimesSync(path, later, later);
  expect((await api(`${reserved.candidateId}/apply/preview`)).status).toBe(409); expect(existsSync(marker)).toBe(false);
});
