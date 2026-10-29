import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { candidateIdentity } from '../src/work/integration-candidate';
import { IntegrationVerification } from '../src/work/integration-verification';
import { IntegrationEditing } from '../src/work/integration-editing';
import { ProjectResolver } from '../src/projects/resolver';
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
function verified() { const command = works.execution.commands(work)[0]; store.record('verified', 'a', 'verification', { commandId: command.id, scope: 'full', status: 'passed', revision: works.execution.revision(work), sourceMutationVersion: work.sourceMutationVersion, commandVersion: JSON.stringify(command) }); }
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c-')); source = join(dir, 's'); mkdirSync(source); mkdirSync(join(dir, 'c'));
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

it('후보 CLI는 실제 후보 cwd를 사용하며 업무 통과를 재사용하지 않고 변경 시 stale이 된다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', "console.log(process.cwd()); setTimeout(()=>process.exit(0),250)"] }]; store.save(work);
  await seed();
  const path = reserved.executionPath, sourceHead = git(source, 'rev-parse', 'HEAD'), workHead = git(work.executionPath!, 'rev-parse', 'HEAD');
  const preview = await api(`${reserved.candidateId}/verification/preview`); expect(preview.status).toBe(200);
  expect(preview.data.results).toEqual([]); expect(preview.data.ready).toBe(false);
  const input = { requestKey: 'verify', confirmed: true, candidateVersion: preview.data.candidateVersion };
  const run = await api(`${reserved.candidateId}/verification/run`, input); expect(run.status).toBe(200); expect(run.data.status).toBe('running');
  expect((await api(`${reserved.candidateId}/verification/run`, input)).data.id).toBe(run.data.id);
  expect((await api(`${reserved.candidateId}/verification/run`, { ...input, candidateVersion: '0'.repeat(64) })).status).toBe(409);
  let status: any;
  for (let n = 0; n < 100; n++) { status = await api(`${reserved.candidateId}/verification/status`); if (status.data.runs.at(-1)?.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 100)); }
  expect(status.data.runs.at(-1).status).toBe('passed'); expect(status.data.runs.at(-1).commands[0].stdout).toContain(path);
  expect(status.data.ready).toBe(true); expect(store.get('a')?.state).toBe('idle'); expect(git(source, 'rev-parse', 'HEAD')).toBe(sourceHead); expect(git(work.executionPath!, 'rev-parse', 'HEAD')).toBe(workHead);
  writeFileSync(join(path, 'code.txt'), 'external candidate edit');
  const stale = await api(`${reserved.candidateId}/verification/results`); expect(stale.data.runs.at(-1).fresh).toBe(false); expect(stale.data.ready).toBe(false); expect(store.integrationRequests()[0].status).toBe('validating');
  expect((await api(`${reserved.candidateId}/verification/run`, { ...input, requestKey: 'dirty' })).status).toBe(409);
  expect((await api(`${reserved.candidateId}/verification/run`, input)).data.id).toBe(run.data.id);
});


async function start(key = 'verify') {
  const preview = await api(`${reserved.candidateId}/verification/preview`); expect(preview.status).toBe(200);
  const input = { requestKey: key, confirmed: true, candidateVersion: preview.data.candidateVersion };
  const response = await api(`${reserved.candidateId}/verification/run`, input); expect(response.status).toBe(200);
  return { input, row: response.data };
}
async function ended() {
  for (let n = 0; n < 150; n++) { const row = store.records('a', 'candidate-verification').at(-1); if (row?.status !== 'running' && app.get(DesktopLifecycle).requests === 0) return row; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('candidate command did not settle');
}
it('다른 업무의 질문 대기는 허용하고 타 Store는 후보 실행 intent로 편집을 차단한다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(0),700)'] }]; store.save(work); await seed();
  store.save({ ...work, id: 'b', requestKey: 'b', changeName: 'b', executionPath: join(dirname(source), 'other'), workspace: undefined, state: 'waiting-input' });
  const { row } = await start(), other = new WorkStore();
  try {
    expect(other.records('a', 'workspace-git-intent').some(intent => intent.stage === 'candidate-verification' && intent.scope === 'workspace' && intent.status === 'running')).toBe(true);
    expect(() => projectCoordinator(other).assertOperationCanStart({ kind: 'workspace', root: reserved.executionPath, commonDir: reserved.commonDir })).toThrow(/미확인|Git/);
    expect(() => projectCoordinator(other).assertOperationCanStart({ kind: 'documents', root: source, changeName: 'other' })).not.toThrow();
    const cancel = await api(`${reserved.candidateId}/verification/cancel`, { runId: row.id }); expect(cancel.data.cancelRequested).toBe(true);
    expect((await ended()).status).toBe('interrupted'); expect(app.get(DesktopLifecycle).requests).toBe(0); expect(store.get('b')?.state).toBe('waiting-input');
  } finally { other.onApplicationShutdown(); }
});
it('후보 명령 실패는 다음 명령을 실행하지 않고 업무 검증 history를 보존한다', async () => {
  work.verificationCommands = [{ id: 'fail', command: process.execPath, args: ['-e', "console.log('candidate failure');process.exit(7)"] }, { id: 'never', command: process.execPath, args: ['-e', "require('fs').writeFileSync('unexpected.txt','ran')"] }]; store.save(work); await seed();
  await start(); const row = await ended(); expect(row.status).toBe('failed'); expect(row.commands).toHaveLength(1); expect(row.commands[0].stdout).toContain('candidate failure'); expect(existsSync(join(reserved.executionPath, 'unexpected.txt'))).toBe(false);
  const status = await api(`${reserved.candidateId}/verification/results`); expect(status.data.ready).toBe(false); expect(store.records('a', 'verification')).toHaveLength(1);
});
it('CLI 통과 뒤 명령 버전 또는 필수 브라우저 설정 변경은 이전 통과를 ready로 쓰지 않는다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  await start(); expect((await ended()).status).toBe('passed');
  work.browserScenario = { version: 1, steps: [{ type: 'expect', text: 'work browser pass' }] }; store.save(work); store.record('browser-work-pass', 'a', 'browser-verification', { status: 'passed', fresh: true });
  const required = await api(`${reserved.candidateId}/verification/results`); expect(required.data.browserRequired).toBe(true); expect(required.data.browserStatus).toBe('not-run-for-candidate'); expect(required.data.ready).toBe(false); expect(required.data.runs.at(-1).fresh).toBe(false);
  work.verificationCommands = []; store.save(work);
  expect((await api(`${reserved.candidateId}/verification/preview`)).status).toBe(409);
  expect(store.records('a', 'candidate-verification').at(-1)?.status).toBe('passed');
});
it('검증 결과 저장 응답 유실은 동일 키로 재실행하지 않고 명시 관찰로 interrupted를 남긴다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  const record = store.record.bind(store); let lost = false;
  vi.spyOn(store, 'record').mockImplementation((id, workId, kind, data: any) => { if (!lost && kind === 'candidate-verification' && data.status === 'passed') { lost = true; throw new Error('result publication lost'); } return record(id, workId, kind, data); });
  const { row, input } = await start();
  for (let n = 0; n < 150 && !lost; n++) await new Promise(resolve => setTimeout(resolve, 100));
  expect(lost).toBe(true); expect(store.records('a', 'candidate-verification')).toHaveLength(1);
  expect((await api(`${reserved.candidateId}/verification/run`, input)).data.id).toBe(row.id);
  const reconciled = await api(`${reserved.candidateId}/verification/reconcile`, { runId: row.id, confirmed: true }); expect(reconciled.data.status).toBe('interrupted'); expect(app.get(DesktopLifecycle).requests).toBe(0);
  expect(store.records('a', 'candidate-verification')).toHaveLength(1);
});


it('동일 요청 키의 동시 admission은 하나의 후보 실행만 예약한다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  const preview = await api(`${reserved.candidateId}/verification/preview`), input = { requestKey: 'race', confirmed: true, candidateVersion: preview.data.candidateVersion };
  const [a, b] = await Promise.all([api(`${reserved.candidateId}/verification/run`, input), api(`${reserved.candidateId}/verification/run`, input)]);
  expect(a.status).toBe(200); expect(b.status).toBe(200); expect(a.data.id).toBe(b.data.id); expect(store.records('a', 'candidate-verification')).toHaveLength(1); expect((await ended()).status).toBe('passed');
});
it('필수 브라우저가 있는 후보는 CLI가 통과해도 업무 브라우저 통과로 ready가 되지 않는다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; work.browserScenario = { version: 1, steps: [{ type: 'expect', text: 'fixture' }] }; store.save(work);
  work.reviewedVersion = works.planVersion(work); store.save(work); await seed(); store.record('browser-work-pass', 'a', 'browser-verification', { status: 'passed' });
  await start(); expect((await ended()).status).toBe('passed'); const status = await api(`${reserved.candidateId}/verification/results`);
  expect(status.data.cliPassed).toBe(true); expect(status.data.browserRequired).toBe(true); expect(status.data.ready).toBe(false); expect(store.integrationRequests()[0].status).toBe('validating');
});
it.each(['target', 'work', 'plan', 'commands'])('통과 뒤 %s 변경은 기록을 보존하면서 필수 후보 검증을 stale로 만든다', async changed => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  await start(); const passed = await ended(); expect(passed.status).toBe('passed');
  if (changed === 'target') git(source, 'commit', '--allow-empty', '-m', 'target moved');
  if (changed === 'work') git(work.executionPath!, 'commit', '--allow-empty', '-m', 'work result moved');
  if (changed === 'plan') writeFileSync(join(work.executionPath!, 'openspec/changes/a/design.md'), '# Changed plan\n');
  if (changed === 'commands') { work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(1)'] }]; store.save(work); }
  const stale = await api(`${reserved.candidateId}/verification/results`); expect(stale.data.ready).toBe(false); expect(stale.data.runs.at(-1).fresh).toBe(false); expect(stale.data.runs.at(-1).status).toBe('passed'); expect(stale.data.runs.at(-1).id).toBe(passed.id);
  expect(store.integrationRequests()[0].status).toBe('validating');
});
it('실행 중 실제 후보 소스 변경은 성공 exit를 stale로 남긴다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', "console.log('start');setTimeout(()=>process.exit(0),2000)"] }]; store.save(work); await seed();
  await start();
  for (let n = 0; n < 150 && !store.records('a', 'candidate-verification').at(-1)?.processId; n++) await new Promise(resolve => setTimeout(resolve, 100));
  expect(store.records('a', 'candidate-verification').at(-1)?.processId).toBeTruthy(); writeFileSync(join(reserved.executionPath, 'code.txt'), 'edited during command');
  const row = await ended(); expect(row.status).toBe('stale'); expect(row.commands[0].status).toBe('passed'); expect(store.integrationRequests()[0].status).toBe('validating');
});

it('Job 가드가 없으면 프로젝트 명령을 시작하지 않고 확인한 waiting worker 종료 뒤 scope를 해제한다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', "require('fs').writeFileSync('must-not-run.txt','ran')"] }]; store.save(work); await seed();
  const previous = process.env.OPENSPEC_BROWSER_DIRECTORY; process.env.OPENSPEC_BROWSER_DIRECTORY = join(dirname(source), 'missing-guard');
  try {
    await start(); const row = await ended(); expect(row.status).toBe('blocked'); expect(row.processTerminated).toBe(true); expect(existsSync(join(reserved.executionPath, 'must-not-run.txt'))).toBe(false); expect(app.get(DesktopLifecycle).requests).toBe(0);
    expect(() => projectCoordinator(store).assertOperationCanStart({ kind: 'workspace', root: reserved.executionPath, commonDir: reserved.commonDir })).not.toThrow();
  } finally { if (previous === undefined) delete process.env.OPENSPEC_BROWSER_DIRECTORY; else process.env.OPENSPEC_BROWSER_DIRECTORY = previous; }
});
it('실행 PID 저장 실패는 waiting worker에 명령을 보내지 않고 소유 종료를 확인한다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', "require('fs').writeFileSync('must-not-run.txt','ran')"] }]; store.save(work); await seed();
  const record = store.record.bind(store); let failed = false;
  vi.spyOn(store, 'record').mockImplementation((id, workId, kind, data: any) => { if (!failed && kind === 'candidate-verification' && data.processId && data.status === 'running' && !data.commands.length) { failed = true; throw new Error('spawn receipt lost'); } return record(id, workId, kind, data); });
  await start(); const row = await ended(); expect(failed).toBe(true); expect(row.status).toBe('blocked'); expect(row.processTerminated).toBe(true); expect(existsSync(join(reserved.executionPath, 'must-not-run.txt'))).toBe(false); expect(app.get(DesktopLifecycle).requests).toBe(0);
});

it('재시작의 종료 불명 기록은 자동 재실행·PID 중단·명시 확인만으로 잠금 해제를 하지 않는다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const preview = await api(`${reserved.candidateId}/verification/preview`), input = { requestKey: 'restart', confirmed: true, candidateVersion: preview.data.candidateVersion };
  const id = `candidate-verification:${hash(['a', reserved.candidateId, input.requestKey])}`, intentId = `${id}:scope`;
  store.record(id, 'a', 'candidate-verification', { id, workId: 'a', candidateId: reserved.candidateId, fingerprint: hash(input), requestKey: input.requestKey, candidateVersion: input.candidateVersion, commands: [], status: 'running', processTerminated: false, processId: process.pid, intentId });
  store.record(intentId, 'a', 'workspace-git-intent', { scope: 'workspace', root: reserved.executionPath, commonDir: reserved.commonDir, refs: [`refs/heads/codex/integration-${reserved.candidateId}`], stage: 'candidate-verification', status: 'running' });
  new IntegrationVerification(store, works, app.get(ProjectResolver), app.get(WorkspaceSettingsService), app.get(DesktopLifecycle), app.get(IntegrationEditing));
  const replay = await api(`${reserved.candidateId}/verification/run`, input); expect(replay.data.status).toBe('interrupted'); expect(replay.data.id).toBe(id); expect(store.records('a', 'candidate-verification')).toHaveLength(1);
  expect((await api(`${reserved.candidateId}/verification/cancel`, { runId: id })).data.cancelRequested).toBe(false);
  expect((await api(`${reserved.candidateId}/verification/reconcile`, { runId: id, confirmed: true })).data.reconciliation).toBe('termination-unconfirmed');
  const other = new WorkStore(); try { expect(() => projectCoordinator(other).assertOperationCanStart({ kind: 'workspace', root: reserved.executionPath, commonDir: reserved.commonDir })).toThrow(/미확인|Git/); } finally { other.onApplicationShutdown(); }
  expect(app.get(DesktopLifecycle).status().idle).toBe(false);
});

it('늦은 V1 조회는 타 Store가 게시한 V2 epoch와 ready proof를 덮지 않고 stale로 응답한다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  await start(); expect((await ended()).status).toBe('passed');
  const verification = app.get(IntegrationVerification), original = verification.capture.bind(verification), other = new WorkStore(); let injected = false;
  vi.spyOn(verification, 'capture').mockImplementation(async (...args: any[]) => {
    const captured = await original(...args);
    if (!injected) { injected = true; const current = other.integrationRequests()[0]; other.record(current.id, 'a', 'integration-request', { ...current, candidateMutationVersion: 'v2-new-epoch', status: 'ready', verificationRefs: ['v2-new-proof'] }); }
    return captured;
  });
  try {
    const response = await api(`${reserved.candidateId}/verification/results`); expect(response.status).toBe(200); expect(injected).toBe(true);
    expect(response.data.ready).toBe(false); expect(response.data.runs.at(-1).fresh).toBe(false);
    expect(store.integrationRequests()[0]).toMatchObject({ candidateMutationVersion: 'v2-new-epoch', status: 'ready', verificationRefs: ['v2-new-proof'] });
  } finally { other.onApplicationShutdown(); }
});

it('호스트 Node 부팅 옵션은 Job 준비 전 후보 bootstrap 코드를 실행하지 못한다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  const oldOptions = process.env.NODE_OPTIONS, oldPath = process.env.NODE_PATH, oldGuard = process.env.OPENSPEC_BROWSER_DIRECTORY;
  process.env.NODE_OPTIONS = '--require ./bootstrap.cjs'; process.env.NODE_PATH = '.'; process.env.OPENSPEC_BROWSER_DIRECTORY = join(dirname(source), 'missing-guard');
  try {
    await start(); const row = await ended(); expect(row.status).toBe('blocked');
    expect(existsSync(join(reserved.executionPath, 'bootstrap-before-job.txt'))).toBe(false);
    expect(row.processTerminated).toBe(true); expect(app.get(DesktopLifecycle).requests).toBe(0);
  } finally {
    if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
    if (oldPath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = oldPath;
    if (oldGuard === undefined) delete process.env.OPENSPEC_BROWSER_DIRECTORY; else process.env.OPENSPEC_BROWSER_DIRECTORY = oldGuard;
  }
});

it('늦은 V1 실행 종료는 새 세대의 통과 record와 ready 근거를 덮지 않는다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  const verification = app.get(IntegrationVerification), original = verification.capture.bind(verification), other = new WorkStore(); let injected = false;
  vi.spyOn(verification, 'capture').mockImplementation(async (...args: any[]) => {
    const captured = await original(...args), currentRun = store.records('a', 'candidate-verification').at(-1);
    if (!injected && currentRun?.status === 'running' && currentRun.processTerminated === true && currentRun.commands.length) {
      injected = true; const current = other.integrationRequests()[0], basis = { ...captured.basis, candidateEpoch: 'v2-completion' }, version = createHash('sha256').update(JSON.stringify(basis)).digest('hex');
      other.record('v2-passed', 'a', 'candidate-verification', { ...currentRun, id: 'v2-passed', requestKey: 'newer', basis, candidateVersion: version, status: 'passed', processTerminated: true });
      other.record(current.id, 'a', 'integration-request', { ...current, candidateMutationVersion: 'v2-completion', status: 'ready', verificationRefs: ['v2-passed'] });
    }
    return captured;
  });
  try {
    await start(); const row = await ended(); expect(injected).toBe(true); expect(row.id).toBe('v2-passed');
    expect(store.integrationRequests()[0]).toMatchObject({ candidateMutationVersion: 'v2-completion', status: 'ready', verificationRefs: ['v2-passed'] });
    const status = await api(`${reserved.candidateId}/verification/results`); expect(status.data.ready).toBe(true); expect(status.data.runs.find((run: any) => run.id !== 'v2-passed').fresh).toBe(false);
    expect(store.integrationRequests()[0].verificationRefs).toEqual(['v2-passed']);
  } finally { other.onApplicationShutdown(); }
});

it('근거 버전: 원시 파일이 같아도 업무 mutation 세대가 바뀌면 과거 통과는 stale이다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  await start(); const passed = await ended(); expect(passed.status).toBe('passed');
  work.sourceMutationVersion = 'next-work-source-generation'; store.save(work);
  const status = await api(`${reserved.candidateId}/verification/results`); expect(status.data.ready).toBe(false); expect(status.data.runs.at(-1).fresh).toBe(false); expect(status.data.runs.at(-1).status).toBe('passed');
});
it('근거 버전: 검토된 준비 정책 버전과 관련 policy record 변경은 과거 통과를 stale로 만든다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  await start(); expect((await ended()).status).toBe('passed');
  work.workspace!.preparationPolicyVersion = (work.workspace!.preparationPolicyVersion ?? 0) + 1; work.workspace!.preparationPolicyDigest = 'next-reviewed-policy'; store.save(work);
  store.record('next-policy', 'a', 'workspace-local-policy', { version: 2, policyDigest: 'next-reviewed-policy' });
  const status = await api(`${reserved.candidateId}/verification/results`); expect(status.data.ready).toBe(false); expect(status.data.runs.at(-1).fresh).toBe(false);
});
it('근거 버전: 실제 Node 실행 파일이 있는 runtime directory 해석 변경은 과거 통과를 stale로 만든다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: 'node', args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  await start(); expect((await ended()).status).toBe('passed');
  const runtime = join(dirname(source), 'alternate-runtime'); mkdirSync(runtime); copyFileSync(process.execPath, join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'));
  const previous = process.env.OPENSPEC_NODE_DIRECTORY; process.env.OPENSPEC_NODE_DIRECTORY = runtime;
  try { const status = await api(`${reserved.candidateId}/verification/results`); expect(status.data.ready).toBe(false); expect(status.data.runs.at(-1).fresh).toBe(false); }
  finally { if (previous === undefined) delete process.env.OPENSPEC_NODE_DIRECTORY; else process.env.OPENSPEC_NODE_DIRECTORY = previous; }
});
it('종료 receipt 유실: 같은 live owner의 확인된 종료만 명시 reconcile로 interrupted 보존한다', async () => {
  work.verificationCommands = [{ id: 'fixture', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(work); await seed();
  const record = store.record.bind(store); let rejectWrites = true, rejected = 0;
  vi.spyOn(store, 'record').mockImplementation((id, workId, kind, data: any) => { if (rejectWrites && kind === 'candidate-verification' && data.processTerminated === true && data.commands.length) { rejected++; throw new Error('cleanup receipt write unavailable'); } return record(id, workId, kind, data); });
  const { row } = await start();
  for (let n = 0; n < 150 && rejected < 2; n++) await new Promise(resolve => setTimeout(resolve, 100));
  expect(rejected).toBeGreaterThanOrEqual(2); rejectWrites = false;
  const durable = store.records('a', 'candidate-verification').at(-1)!; expect(durable.status).toBe('running'); expect(durable.processTerminated).toBe(false); expect(app.get(DesktopLifecycle).requests).toBe(1);
  for (const changed of [{ owner: 'different-owner-generation' }, { runGeneration: 'different-run-generation' }, { fingerprint: 'different-request' }]) {
    store.record(durable.id, 'a', 'candidate-verification', { ...durable, ...changed });
    expect((await api(`${reserved.candidateId}/verification/reconcile`, { runId: row.id, confirmed: true })).data.reconciliation).toBe('termination-unconfirmed'); expect(app.get(DesktopLifecycle).requests).toBe(1);
  }
  store.record(durable.id, 'a', 'candidate-verification', durable);
  rejectWrites = true;
  expect((await api(`${reserved.candidateId}/verification/reconcile`, { runId: row.id, confirmed: true })).status).toBe(500); expect(app.get(DesktopLifecycle).requests).toBe(1);
  expect(() => projectCoordinator(store).assertOperationCanStart({ kind: 'workspace', root: reserved.executionPath, commonDir: reserved.commonDir })).toThrow(/진행|미확인|Git/);
  rejectWrites = false;
  const reconciled = await api(`${reserved.candidateId}/verification/reconcile`, { runId: row.id, confirmed: true }); expect(reconciled.data.status).toBe('interrupted'); expect(reconciled.data.processTerminated).toBe(true); expect(app.get(DesktopLifecycle).requests).toBe(0);
  expect(store.records('a', 'candidate-verification')).toHaveLength(1); expect(store.integrationRequests()[0].status).toBe('validating');
});
