import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { candidateIdentity } from '../src/work/integration-candidate';
import { IntegrationApplyPreflight } from '../src/work/integration-apply-preflight';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/app';
import { WorkStore, type Work } from '../src/work/store';
import { WorkService } from '../src/work/work.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorktreeManager } from '../src/work/worktree-manager';
import { collectWorkspaceDocuments } from '../src/work/workspace-documents';
import * as runner from '../src/projects/git-runner';
import { DesktopLifecycle } from '../src/desktop/lifecycle';
import { IntegrationApply } from '../src/work/integration-apply';
import { IntegrationService } from '../src/work/integration.service';
import { CompletedResults } from '../src/work/completed-results';
import { OpenSpecService } from '../src/openspec/openspec.service';
import { projectCoordinator } from '../src/projects/coordinator';
import { fileURLToPath } from 'node:url';
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let app: any, base: string, source: string, store: WorkStore, work: Work, works: WorkService, reserved: any;
const savedEnv = { CONFIG_PATH: process.env.CONFIG_PATH, DATA_DIR: process.env.DATA_DIR, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
async function api(path: string, body?: unknown) { const r = await fetch(`${base}/api/work/${work.id}/integration/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; }
function verified() { const command = works.execution.commands(work)[0]; store.record('verified-'+work.id, work.id, 'verification', { commandId: command.id, scope: 'full', status: 'passed', revision: works.execution.revision(work), sourceMutationVersion: work.sourceMutationVersion, commandVersion: JSON.stringify(command) }); }
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r-')); source = join(dir, 's'); mkdirSync(source); mkdirSync(join(dir, 'c'));
  git(source, 'init', '-b', 'main'); git(source, 'config', 'core.autocrlf', 'false'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test');
  const docs = join(source, 'openspec/changes/a'); mkdirSync(join(docs, 'specs/demo'), { recursive: true });
  for (const path of ['proposal.md', 'design.md', 'tasks.md', 'specs/demo/spec.md']) writeFileSync(join(docs, path), '# Plan\n');
  writeFileSync(join(source, 'code.txt'), 'base\n');
  writeFileSync(join(source, 'bootstrap.cjs'), "require('fs').writeFileSync('bootstrap-before-job.txt','ran');");
  writeFileSync(join(source, '.gitignore'), 'ignored-local.txt' + String.fromCharCode(10));
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
  writeFileSync(join(work.executionPath!, 'result-'+work.id+'.txt'), 'result-'+work.id); git(work.executionPath!, 'add', '--', 'result-'+work.id+'.txt'); git(work.executionPath!, 'commit', '-m', 'result fixture');
  const resultCommit = git(work.executionPath!, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'target-'+work.id+'.txt'), 'target-'+work.id); git(source, 'add', '--', 'target-'+work.id+'.txt'); git(source, 'commit', '-m', 'target fixture');
  const space = work.workspace!, candidateId = randomUUID(), container = join(space.managedPath, 'projects', space.projectId, 'integrations', candidateId), path = join(container, 'project');
  mkdirSync(container, { recursive: true });
  git(source, 'worktree', 'add', '-b', `codex/integration-${candidateId}`, '--', path, 'main'); git(path, 'merge', '--no-ff', '-m', 'candidate fixture', resultCommit);
  reserved = { ...space, id: 'integration-fixture-'+work.id, workId: work.id, requestKey: 'integrate', fingerprint: 'fixture', candidateId, executionPath: path, workExecutionPath: work.executionPath!, commonDir: space.commonDir!, projectPath: source, workspaceId: space.workspaceId, targetBranch: 'main', targetHead: git(source, 'rev-parse', 'HEAD'), workHead: initial, resultCommit, resultTree: git(work.executionPath!, 'rev-parse', 'HEAD^{tree}'), candidateCommit: git(path, 'rev-parse', 'HEAD'), reviewedVersion: work.reviewedVersion!, sourceRevision: works.execution.revision(work), workVerificationRefs: ['verified'], verificationRefs: [], conflicts: [], status: 'validating', createdAt: '', updatedAt: '' };
  writeFileSync(join(container, 'identity.json'), JSON.stringify(candidateIdentity(reserved)));
  store.record(reserved.id, work.id, 'integration-request', reserved);
  store.record('prepared-fixture-'+work.id, work.id, 'integration-preparation', { candidateId, status: 'validating', commit: reserved.candidateCommit });
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
  store.record('candidate-pass-'+work.id, work.id, 'candidate-verification', { candidateId: reserved.candidateId, status: 'passed', processTerminated: true, candidateVersion: preview.data.candidateVersion });
}
function preserved() {
  return [source, work.executionPath!, reserved.executionPath].map(root => [git(root, 'rev-parse', 'HEAD'), readFileSync(git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).toString('base64'), git(root, 'status', '--porcelain=v1', '--untracked-files=all'), git(root, 'show-ref'),
    git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])]);
}

async function input(key = 'apply') {
  const preview = await api(`${reserved.candidateId}/apply/preview`); expect(preview.status).toBe(200);
  return { requestKey: key, confirmed: true, expectedVersion: preview.data.expectedVersion };
}
const applying = () => store.records(work.id, 'integration-apply');
const ff = (args: string[]) => args.includes('merge') && args.includes('--ff-only');

async function applied() { await ready(); const body = await input(); const response = await api(`${reserved.candidateId}/apply`, body); expect(response.data.status).toBe('applied'); return response.data; }
async function completeReady(trace: (stage: string) => void = () => {}) {
  trace('prepare');
  writeFileSync(join(work.executionPath!, 'openspec/changes/a/tasks.md'), '- [x] fixture\n');
  git(work.executionPath!, 'add', '--', 'openspec/changes/a/tasks.md'); git(work.executionPath!, 'commit', '-m', 'finish tasks');
  work.reviewedVersion = works.planVersion(work); work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work);
  await seed(); trace('seeded'); reserved.workVerificationRefs = ['verified-'+work.id]; store.record(reserved.id, work.id, 'integration-request', reserved); await certify(); trace('certified');
  const body = await input(); trace('dispatch-apply'); const response = await api(`${reserved.candidateId}/apply`, body); expect(response.data.status).toBe('applied'); trace('applied');
  return response.data;
}
async function workAction(action: string) {
  const response = await fetch(`${base}/api/work/${work.id}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, confirmed: true }) });
  return { status: response.status, data: await response.json() };
}
it('Git 완료는 copy journal 없이 적용 당시 검증과 실제 반영 blob을 보존한다', async () => {
  await completeReady();
  const before = preserved(), run = vi.spyOn(runner, 'runGit');
  const completed = await fetch(`${base}/api/work/${work.id}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'complete', confirmed: true }) });
  expect({ status: completed.status, data: await completed.json() }).toMatchObject({ status: 200, data: { phase: 'completed' } });
  expect(store.records(work.id, 'application')).toEqual([]); expect(preserved()).toEqual(before); expect(run.mock.calls.some(([, args]) => ff(args))).toBe(false);
  const retained = new CompletedResults(store), header = retained.header(work.id);
  expect(header.integration).toMatchObject({ candidateId: reserved.candidateId, targetHead: reserved.targetHead, appliedCommit: reserved.candidateCommit, resultCommit: reserved.resultCommit });
  const files = retained.files(work.id, header.retained.captureId).files;
  const result = files.find((file: any) => file.path === 'result-a.txt');
  expect(retained.file(work.id, header.retained.captureId, result.ordinal)).toMatchObject({ before: null, after: 'result-a' });
  expect(files.some((file: any) => file.path === 'target-a.txt')).toBe(false);
  expect(retained.verifications(work.id, header.retained.captureId).results.map((row: any) => row.id)).toEqual(expect.arrayContaining(['verified-a', 'candidate-pass-a']));
});
it('Git 보관 실패는 반영·완료 캡처를 보존하고 별도 결과와 clean 관측을 남긴다', async () => {
  await completeReady(); expect((await workAction('complete')).status).toBe(200);
  const capture = new CompletedResults(store).header(work.id), openspec = vi.spyOn(app.get(OpenSpecService), 'run').mockResolvedValue({ ok: false, code: 1, stdout: '', stderr: 'archive fixture failure' });
  expect((await workAction('archive')).status).toBe(409);
  expect(store.get(work.id)?.phase).toBe('completed'); expect(applying()[0].status).toBe('applied');
  expect(new CompletedResults(store).header(work.id).retained.captureId).toBe(capture.retained.captureId);
  expect(store.records(work.id, 'archive-attempt').at(-1)).toMatchObject({ status: 'failed', result: { ok: false }, postCheck: { state: 'clean' } }); expect(openspec).toHaveBeenCalledTimes(1);
});
it('Git 보관 dirty는 완료로 남고 사용자 정리 뒤 명시 재확인만 CLI 재실행 없이 보관을 확정한다', async () => {
  const trace = (stage: string) => console.error('[archive-dirty-fixture]', JSON.stringify({ stage, at: Date.now(), pid: process.pid }));
  writeFileSync(join(work.executionPath!, 'openspec/changes/a/specs/demo/spec.md'), '## ADDED Requirements\n\n### Requirement: Archive fixture\nThe system SHALL preserve completed results.\n\n#### Scenario: Result preserved\n- **WHEN** an applied result is archived\n- **THEN** its completion evidence is retained\n');
  git(work.executionPath!, 'add', '--', 'openspec/changes/a/specs/demo/spec.md'); git(work.executionPath!, 'commit', '-m', 'valid archive delta fixture');
  await completeReady(trace); expect((await workAction('complete')).status).toBe(200); trace('completed');
  // Use the real CLI: its verified Windows EPERM fallback is part of archive behavior.
  const openspec = vi.spyOn(app.get(OpenSpecService), 'run');
  expect((await workAction('archive')).status).toBe(409); trace('archive-needs-review');
  const receipt = store.records(work.id, 'archive-attempt').at(-1);
  expect(receipt?.result, JSON.stringify({ status: receipt?.status, result: receipt?.result, postCheck: receipt?.postCheck })).toMatchObject({ ok: true, code: 0 });
  expect(works.get(work.id).phase).toBe('completed'); expect(works.list().find(row => row.id === work.id)?.phase).toBe('completed');
  expect(receipt).toMatchObject({ status: 'needs-review', archiveName: expect.stringMatching(/^\d{4}-\d{2}-\d{2}-a$/), postCheck: { state: 'dirty', nextIntegrationBlocked: true } });
  git(source, 'add', '--all'); git(source, 'commit', '-m', 'explicit fixture archive review'); trace('user-committed');
  expect(await workAction('archive')).toMatchObject({ status: 200, data: { phase: 'archived', archiveName: receipt.archiveName } });
  trace('reconfirmed');
  expect(openspec).toHaveBeenCalledTimes(1); expect(applying()).toHaveLength(1); expect(applying()[0].status).toBe('applied');
  expect(store.records(work.id, 'archive-attempt').at(-1)).toMatchObject({ status: 'archived', postCheck: { state: 'clean', nextIntegrationBlocked: false } });
});
it('Git 완료 캡처 반환 뒤 새 파일 변경은 최종 fence에서 거부하고 보존 캡처를 rollback한다', async () => {
  await completeReady(); const capture = CompletedResults.prototype.capture;
  vi.spyOn(CompletedResults.prototype, 'capture').mockImplementation(function(this: CompletedResults, ...args: Parameters<CompletedResults['capture']>) {
    const result = capture.apply(this, args); writeFileSync(join(work.executionPath!, 'result-a.txt'), 'new edit during completion capture'); return result;
  });
  expect((await workAction('complete')).status).toBe(409); expect(store.get(work.id)?.phase).toBe('verification');
  expect(new CompletedResults(store).header(work.id)).toBeNull(); expect(readFileSync(join(work.executionPath!, 'result-a.txt'), 'utf8')).toBe('new edit during completion capture'); expect(applying()[0].status).toBe('applied');
});
async function lost() {
  await ready(); const body = await input(), record = store.record.bind(store); let failed = false;
  const spy = vi.spyOn(store, 'record').mockImplementation((id, workId, kind, data: any) => { if (!failed && kind === 'integration-apply' && data.status === 'applied') { failed = true; throw new Error('lost result acknowledgement'); } return record(id, workId, kind, data); });
  await api(`${reserved.candidateId}/apply`, body); spy.mockRestore(); expect(failed).toBe(true); expect(applying()[0].status).toBe('uncertain'); return applying()[0];
}
function journal() { return JSON.stringify([store.integrationRequests(), applying(), store.records('a', 'workspace-git-intent'), store.get('a')]); }

it('기본 apply status는 Git 없이 저장 영수증과 live 상태만 읽는다', async () => {
  const row = await applied(), before = journal();
  const run = vi.spyOn(runner, 'runGit'), sync = vi.spyOn(runner, 'readGitSync');
  const response = await api(`${reserved.candidateId}/apply/status`); expect(response.status).toBe(200); expect(response.data.receipt.id).toBe(row.id); expect(response.data.observation.state).toBe('not-checked'); expect(response.data.live.state).toBe('settled');
  expect(run).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled(); expect(journal()).toBe(before);
});
it('명시 inspect는 현재 dirty를 보여도 과거 applied 영수증을 바꾸지 않는다', async () => {
  const row = await applied(); writeFileSync(join(source, 'result-a.txt'), 'external current source'); const before = journal();
  const response = await api(`${reserved.candidateId}/apply/status?inspect=1`); expect(response.status).toBe(200); expect(response.data.receipt.status).toBe('applied'); expect(response.data.receipt.appliedCommit).toBe(row.appliedCommit); expect(response.data.observation.state).toBe('uncertain'); expect(journal()).toBe(before);
});
it('응답 저장 유실은 같은 키로 실제 applied를 재확인하고 own intent만 종결한다', async () => {
  const row = await lost(), run = vi.spyOn(runner, 'runGit');
  const response = await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: row.requestKey, confirmed: true });
  expect(response.status).toBe(200); expect(response.data.receipt.status).toBe('applied'); expect(response.data.receipt.appliedCommit).toBe(reserved.candidateCommit); expect(response.data.reconciled).toBe(true);
  expect(run.mock.calls.some(([, args]) => ff(args))).toBe(false); expect(applying()).toHaveLength(1); expect(store.records('a', 'workspace-git-intent').find(intent => intent.id === row.intentId)?.status).toBe('passed');
  expect(store.integrationRequests()[0]).toMatchObject({ status: 'applied', appliedCommit: reserved.candidateCommit }); expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.candidateCommit);
});
it('재시작 후 영속 quiescent 근거가 있는 이전 apply만 실제 상태로 복구한다', async () => {
  const row = await lost(); expect(row.executionProtocol).toBe('head-pin-job-v1'); expect(row.terminationProof?.state).toBe('job-quiescent');
  await app.close(); app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl(); store = app.get(WorkStore); works = app.get(WorkService);
  const response = await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: row.requestKey, confirmed: true }); expect(response.status).toBe(200); expect(response.data.receipt.status).toBe('applied'); expect(applying()).toHaveLength(1);
});
it.each(['work', 'candidate'])('reconcile 전에 %s 파일을 새로 편집해도 과거 적용을 확인하고 새 파일을 보존한다', async side => {
  const row = await lost(), path = join(side === 'work' ? work.executionPath! : reserved.executionPath, 'result-a.txt');
  writeFileSync(path, 'new edit before recovery'); const before = preserved(), run = vi.spyOn(runner, 'runGit'), saved = journal();
  const inspection = await api(`${reserved.candidateId}/apply/status?inspect=1`);
  expect(inspection.status).toBe(200); expect(inspection.data.observation).toMatchObject({ state: 'applied', sideChanged: true }); expect(journal()).toBe(saved);
  const response = await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: row.requestKey, confirmed: true });
  expect(response.status).toBe(200); expect(response.data.observation).toMatchObject({ state: 'applied', sideChanged: true }); expect(response.data.receipt.status).toBe('applied');
  expect(store.records('a', 'workspace-git-intent').find(intent => intent.id === row.intentId)?.status).toBe('passed');
  expect(run.mock.calls.some(([, args]) => ff(args))).toBe(false); expect(readFileSync(path, 'utf8')).toBe('new edit before recovery'); expect(preserved()).toEqual(before);
});
it('normal apply 원본 관측 뒤 Work 파일 변경은 uncertain이며 명시 과거 관측으로만 복구한다', async () => {
  await ready(); const body = await input(), preflight = app.get(IntegrationApplyPreflight), inspect = preflight.inspectOriginal.bind(preflight); let changed = false;
  const path = join(work.executionPath!, 'result-a.txt');
  const spy = vi.spyOn(preflight, 'inspectOriginal').mockImplementation(async (...args: any[]) => {
    const result = await inspect(...args);
    if (!changed) { changed = true; writeFileSync(path, 'new edit during post observation'); }
    return result;
  });
  const response = await api(`${reserved.candidateId}/apply`, body); spy.mockRestore();
  expect(changed).toBe(true); expect(response.data.status).toBe('uncertain'); expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.candidateCommit);
  expect(store.records('a', 'workspace-git-intent').find(intent => intent.id === response.data.intentId)?.status).toBe('uncertain');
  const before = preserved(), run = vi.spyOn(runner, 'runGit');
  const recovered = await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: body.requestKey, confirmed: true });
  expect(recovered.status).toBe(200); expect(recovered.data.receipt.status).toBe('applied'); expect(recovered.data.observation.sideChanged).toBe(true);
  expect(run.mock.calls.some(([, args]) => ff(args))).toBe(false); expect(readFileSync(path, 'utf8')).toBe('new edit during post observation'); expect(preserved()).toEqual(before);
});
it.each(['missing-pid', 'reused-pid', 'old-protocol'])('%s만으로 미확인 apply 종료를 추정하거나 scope를 해제하지 않는다', async mode => {
  const original = await applied(), row = { ...original, status: 'uncertain', applied: false, processTerminated: true, executionProtocol: mode === 'old-protocol' ? 'legacy' : undefined, terminationProof: undefined, processId: mode === 'missing-pid' ? undefined : process.pid };
  store.record(row.id, 'a', 'integration-apply', row); const intent = store.records('a', 'workspace-git-intent').find(item => item.id === row.intentId)!; store.record(intent.id, 'a', 'workspace-git-intent', { ...intent, status: 'uncertain', processTerminated: true, terminationProof: undefined }); store.record(reserved.id, 'a', 'integration-request', { ...store.integrationRequests()[0], status: 'uncertain' });
  const before = journal(), kill = vi.spyOn(process, 'kill');
  const status = await api(`${reserved.candidateId}/apply/status`); expect(status.data.live.state).toBe('unknown');
  expect((await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: row.requestKey, confirmed: true })).status).toBe(409); expect(journal()).toBe(before); expect(kill).not.toHaveBeenCalled();
});
it('실제 source가 계속 dirty면 명시 reconcile도 uncertain scope를 유지한다', async () => {
  const row = await lost(); writeFileSync(join(source, 'result-a.txt'), 'local unsaved'); const before = preserved();
  const response = await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: row.requestKey, confirmed: true }); expect(response.status).toBe(200); expect(response.data.observation.state).toBe('uncertain'); expect(response.data.receipt.status).toBe('uncertain');
  expect(store.records('a', 'workspace-git-intent').find(intent => intent.id === row.intentId)?.status).toBe('uncertain'); expect(preserved()).toEqual(before);
});
it('종료가 증명되고 원본이 적용 전 그대로면 failed를 확인해 own scope만 해제한다', async () => {
  writeFileSync(join(work.executionPath!, 'ignored-local.txt'), 'candidate'); git(work.executionPath!, 'add', '--force', '--', 'ignored-local.txt'); await ready();
  writeFileSync(join(source, 'ignored-local.txt'), 'keep local'); await certify(); const body = await input(), record = store.record.bind(store); let lost = false;
  const spy = vi.spyOn(store, 'record').mockImplementation((id, workId, kind, data: any) => { if (!lost && kind === 'integration-apply' && data.status === 'failed') { lost = true; throw new Error('lost failed result'); } return record(id, workId, kind, data); });
  await api(`${reserved.candidateId}/apply`, body); spy.mockRestore(); expect(lost).toBe(true); const row = applying()[0]; expect(row.status).toBe('uncertain'); const before = preserved();
  const response = await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: row.requestKey, confirmed: true }); expect(response.status).toBe(200); expect(response.data.receipt.status).toBe('failed'); expect(response.data.observation.state).toBe('failed');
  expect(store.records('a', 'workspace-git-intent').find(intent => intent.id === row.intentId)?.status).toBe('failed'); expect(store.integrationRequests()[0].status).toBe('validating'); expect(preserved()).toEqual(before);
  expect(() => projectCoordinator(store).assertOperationCanStart({ kind: 'workspace', root: source, commonDir: reserved.commonDir })).not.toThrow();
});
it('늦은 reconcile은 다른 Store의 새 generation과 intent를 덮지 않는다', async () => {
  const row = await lost(), other = new WorkStore(), preflight = app.get(IntegrationApplyPreflight), inspect = preflight.inspectOriginal.bind(preflight); let changed = false;
  vi.spyOn(preflight, 'inspectOriginal').mockImplementation(async (...args: any[]) => {
    const result = await inspect(...args);
    if (!changed) { changed = true; const current = other.integrationRequests()[0]; other.record(current.id, 'a', 'integration-request', { ...current, applyAttemptId: 'new-attempt', candidateMutationVersion: 'new-epoch', status: 'applying' }); other.record('new-attempt', 'a', 'integration-apply', { ...row, id: 'new-attempt', requestKey: 'new-key', runGeneration: 'new-generation', status: 'running', processTerminated: false }); }
    return result;
  });
  try {
    const response = await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: row.requestKey, confirmed: true }); expect(response.status).toBe(409); expect(changed).toBe(true);
    expect(store.integrationRequests()[0]).toMatchObject({ applyAttemptId: 'new-attempt', candidateMutationVersion: 'new-epoch', status: 'applying' }); expect(store.records('a', 'workspace-git-intent').find(intent => intent.id === row.intentId)?.status).toBe('uncertain');
  } finally { other.onApplicationShutdown(); }
});
it.each(['work', 'candidate'])('원본 관측 뒤 %s 파일이 바뀌면 오래된 sides로 scope를 종결하지 않는다', async side => {
  const row = await lost(), preflight = app.get(IntegrationApplyPreflight), inspect = preflight.inspectOriginal.bind(preflight); let changed = false;
  vi.spyOn(preflight, 'inspectOriginal').mockImplementation(async (...args: any[]) => {
    const result = await inspect(...args);
    if (!changed) { changed = true; writeFileSync(join(side === 'work' ? work.executionPath! : reserved.executionPath, 'result-a.txt'), 'late '+side+' change'); }
    return result;
  });
  const response = await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: row.requestKey, confirmed: true }); expect(changed).toBe(true); expect(response.status).toBe(409);
  expect(applying()[0].status).toBe('uncertain'); expect(store.records('a', 'workspace-git-intent').find(intent => intent.id === row.intentId)?.status).toBe('uncertain');
});
it('원본 관측 뒤 다른 worktree의 target checkout이 생기면 topology를 재검사한다', async () => {
  const row = await lost(), preflight = app.get(IntegrationApplyPreflight), inspect = preflight.inspectOriginal.bind(preflight); let changed = false;
  vi.spyOn(preflight, 'inspectOriginal').mockImplementation(async (...args: any[]) => {
    const result = await inspect(...args);
    if (!changed) { changed = true; git(source, 'worktree', 'add', '--force', join(dirname(source), 'late-target'), 'main'); }
    return result;
  });
  const response = await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: row.requestKey, confirmed: true }); expect(changed).toBe(true); expect(response.status).toBe(409);
  expect(applying()[0].status).toBe('uncertain'); expect(store.records('a', 'workspace-git-intent').find(intent => intent.id === row.intentId)?.status).toBe('uncertain');
});
it('live apply는 active로 표시하고 reconcile과 cancel이 실행을 끊지 않는다', async () => {
  await ready(); const body = await input(), run = runner.runGit; let waiting = false, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(runner, 'runGit').mockImplementation((root, args, options, optional) => {
    if (ff(args) && options?.headPin) { const fence = options.headPin.beforeDispatch; options = { ...options, headPin: { ...options.headPin, beforeDispatch: async () => { await fence(); waiting = true; await gate; } } }; }
    return run(root, args, options, optional);
  });
  const executing = api(`${reserved.candidateId}/apply`, body);
  try { await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 15000 });
    expect((await api(`${reserved.candidateId}/apply/status`)).data.live.state).toBe('active'); expect(app.get(DesktopLifecycle).status().blockers.some((item: any) => item.reasons.includes('실행 중'))).toBe(true);
    expect((await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: body.requestKey, confirmed: true })).status).toBe(409); expect((await api(`${reserved.candidateId}/cancel`, { confirmed: true })).status).toBe(409);
  } finally { release(); expect((await executing).data.status).toBe('applied'); }
});
it('준비된 후보의 논리 취소는 Git·파일·대화·검증 결과를 보존한다', async () => {
  await ready(); const before = preserved(), thread = work.threadId, verification = store.records('a', 'candidate-verification');
  const response = await api(`${reserved.candidateId}/cancel`, { confirmed: true }); expect(response.status).toBe(200); expect(response.data.cancelled).toBe(true); expect(store.integrationRequests()[0].status).toBe('cancelled');
  expect(preserved()).toEqual(before); expect(store.get('a')?.threadId).toBe(thread); expect(store.records('a', 'candidate-verification')).toEqual(verification); expect(app.get(IntegrationService).status('a').active).toBe(null);
});
it('이미 applied인 후보 취소는 applied와 원본 HEAD를 보존하는 no-op이다', async () => {
  const row = await applied(), before = journal(), gitBefore = preserved();
  const response = await api(`${reserved.candidateId}/cancel`, { confirmed: true }); expect(response.status).toBe(200); expect(response.data).toMatchObject({ alreadyApplied: true, cancelled: false, appliedCommit: row.appliedCommit });
  expect(journal()).toBe(before); expect(preserved()).toEqual(gitBefore);
});
async function queued() {
  const space = work.workspace!, candidateId = randomUUID(), head = git(source, 'rev-parse', 'HEAD');
  reserved = { ...space, id: 'queued-reservation', workId: work.id, requestKey: 'queued', fingerprint: 'queued', candidateId, executionPath: join(space.managedPath, 'projects', space.projectId, 'integrations', candidateId, 'project'), workExecutionPath: work.executionPath!, commonDir: space.commonDir!, projectPath: source, workspaceId: space.workspaceId, targetBranch: 'main', targetHead: head, workHead: git(work.executionPath!, 'rev-parse', 'HEAD'), candidateCommit: null, reviewedVersion: work.reviewedVersion, sourceRevision: works.execution.revision(work), workVerificationRefs: [], verificationRefs: [], conflicts: [], status: 'queued', createdAt: '', updatedAt: '' };
  store.record(reserved.id, 'a', 'integration-request', reserved);
}
it('아직 폴더·branch 없는 queued 예약도 dirty 원본을 정리하지 않고 취소한다', async () => {
  await queued(); writeFileSync(join(source, 'local-unsaved.txt'), 'keep');
  expect(existsSync(reserved.executionPath)).toBe(false); const response = await api(`${reserved.candidateId}/cancel`, { confirmed: true }); expect(response.status).toBe(200); expect(response.data.cancelled).toBe(true);
  expect(existsSync(reserved.executionPath)).toBe(false); expect(readFileSync(join(source, 'local-unsaved.txt'), 'utf8')).toBe('keep'); expect(git(source, 'for-each-ref', '--format=%(refname)', `refs/heads/codex/integration-${reserved.candidateId}`)).toBe('');
});
it.each(['question', 'prepare-intent', 'unknown-scope'])('queued 취소도 %s가 있으면 해제하지 않는다', async mode => {
  await queued();
  if (mode === 'question') store.record('question', 'a', 'question', { status: 'pending' });
  else store.record('pending-scope', 'a', 'workspace-git-intent', { ...(mode === 'prepare-intent' ? { scope: 'management' } : {}), root: reserved.executionPath, commonDir: reserved.commonDir, status: 'uncertain', owner: 'other', runGeneration: 'unknown' });
  const before = journal(); expect((await api(`${reserved.candidateId}/cancel`, { confirmed: true })).status).toBe(409); expect(journal()).toBe(before);
});
it('허용하지 않은 query·reconcile body·타 key는 경로를 읽지 않고 거부한다', async () => {
  await ready();
  expect((await api(`${reserved.candidateId}/apply/status?path=other`)).status).toBe(400); expect((await api(`${reserved.candidateId}/apply/status?inspect=0`)).status).toBe(400);
  expect((await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: 'missing', confirmed: true, path: source })).status).toBe(400); expect((await api(`${reserved.candidateId}/apply/reconcile`, { requestKey: 'missing', confirmed: true })).status).toBe(404);
});

it.each(['terminal-failed', 'new-attempt', 'new-observation'])('오래된 apply fallback은 다른 Store의 %s 기록을 덮지 않는다', async mode => {
  if (mode === 'terminal-failed') { writeFileSync(join(work.executionPath!, 'ignored-local.txt'), 'candidate'); git(work.executionPath!, 'add', '--force', '--', 'ignored-local.txt'); }
  await ready();
  if (mode === 'terminal-failed') { writeFileSync(join(source, 'ignored-local.txt'), 'keep local'); await certify(); }
  const body = await input(), other = new WorkStore(), service = app.get(IntegrationApply) as any, publish = service.publish.bind(service), run = vi.spyOn(runner, 'runGit');
  let snapshot = '', expected: any, changed = false;
  vi.spyOn(service, 'publish').mockImplementation((row: any, request: any, intent: any) => {
    other.transaction(() => {
      const durable = other.records('a', 'integration-apply').find(item => item.id === row.id)!, current = other.integrationRequests().find(item => item.id === request.id)!, own = other.records('a', 'workspace-git-intent').find(item => item.id === row.intentId)!;
      if (mode === 'terminal-failed') {
        expect(row.status).toBe('failed');
        other.record(row.id, 'a', 'integration-apply', { ...durable, status: 'failed', applied: false, reconciledAt: 'other-store', lastObservation: { state: 'failed', checkedAt: 'other-store' } });
        other.record(own.id, 'a', 'workspace-git-intent', { ...own, status: 'failed' }); other.record(current.id, 'a', 'integration-request', { ...current, status: 'validating' });
      } else if (mode === 'new-attempt') {
        // Leave the old intent active: request/attempt ownership itself must fence fallback.
        expect(own.status).toBe('running');
        other.record('next-attempt', 'a', 'integration-apply', { ...durable, id: 'next-attempt', requestKey: 'next-key', runGeneration: 'next-generation', intentId: 'next-intent', status: 'running' });
        other.record('next-intent', 'a', 'workspace-git-intent', { ...own, id: 'next-intent', runGeneration: 'next-generation' });
        other.record(current.id, 'a', 'integration-request', { ...current, status: 'applying', applyAttemptId: 'next-attempt' });
      } else {
        other.record(row.id, 'a', 'integration-apply', { ...durable, status: 'uncertain', lastObservation: { state: 'uncertain', checkedAt: 'new-observation', reason: 'new external observation' } });
        other.record(own.id, 'a', 'workspace-git-intent', { ...own, status: 'uncertain' }); other.record(current.id, 'a', 'integration-request', { ...current, status: 'uncertain' });
      }
    });
    changed = true; snapshot = journal(); expected = other.records('a', 'integration-apply').find(item => item.id === row.id);
    return publish(row, request, intent);
  });
  try {
    const response = await api(`${reserved.candidateId}/apply`, body);
    expect(changed).toBe(true); expect(journal()).toBe(snapshot); expect(response.data).toEqual(expected);
    expect(run.mock.calls.filter(([, args]) => ff(args))).toHaveLength(1);
    expect(git(source, 'rev-parse', 'HEAD')).toBe(mode === 'terminal-failed' ? reserved.targetHead : reserved.candidateCommit);
    if (mode === 'terminal-failed') expect(readFileSync(join(source, 'ignored-local.txt'), 'utf8')).toBe('keep local');
  } finally { other.onApplicationShutdown(); }
});
