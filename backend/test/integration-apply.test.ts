import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync, renameSync } from 'node:fs';
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
import { WorkspaceService } from '../src/work/workspace.service';
import { WorkspacePreparation } from '../src/work/workspace-preparation';
import { WorkspaceCleanup } from '../src/work/workspace-cleanup';
import { CompletedResults } from '../src/work/completed-results';
import { DesktopLifecycle } from '../src/desktop/lifecycle';
import { fileURLToPath } from 'node:url';
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let app: any, base: string, source: string, store: WorkStore, work: Work, works: WorkService, reserved: any;
const savedEnv = { CONFIG_PATH: process.env.CONFIG_PATH, DATA_DIR: process.env.DATA_DIR, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
async function api(path: string, body?: unknown) { const r = await fetch(`${base}/api/work/${work.id}/integration/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; }
function verified() { const command = works.execution.commands(work)[0]; store.record('verified-'+work.id, work.id, 'verification', { commandId: command.id, scope: 'full', status: 'passed', revision: works.execution.revision(work), sourceMutationVersion: work.sourceMutationVersion, commandVersion: JSON.stringify(command) }); }
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f-')); source = join(dir, 's'); mkdirSync(source); mkdirSync(join(dir, 'c'));
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

it('명시 확정은 실제 ff-only 적용 HEAD를 저장하고 업무·후보를 보존한다', async () => {
  await ready(); const before = preserved(), body = await input();
  const response = await api(`${reserved.candidateId}/apply`, body); expect(response.status).toBe(200);
  expect(response.data).toMatchObject({ status: 'applied', applied: true, appliedCommit: reserved.candidateCommit, observedHead: reserved.candidateCommit, processTerminated: true });
  expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.candidateCommit); expect(readFileSync(join(source, 'result-a.txt'), 'utf8')).toBe('result-a');
  const local = (values: any[][]) => values.slice(1).map(([head, index, status, , files]) => [head, index, status, files]);
  expect(local(preserved())).toEqual(local(before)); expect(store.integrationRequests()[0]).toMatchObject({ status: 'applied', appliedCommit: reserved.candidateCommit });
  expect(applying()).toHaveLength(1); expect(store.records('a', 'workspace-git-intent').some(row => row.stage === 'integration-apply' && row.status === 'passed' && row.processId > 0)).toBe(true);
  expect(app.get(DesktopLifecycle).requests).toBe(0);
});
it('같은 키의 적용 영수증은 원본이 나중에 바뀌어도 mutable 검사보다 먼저 반환한다', async () => {
  await ready(); const body = await input(), first = await api(`${reserved.candidateId}/apply`, body); expect(first.status).toBe(200);
  git(source, 'commit', '--allow-empty', '-m', 'later source'); const later = git(source, 'rev-parse', 'HEAD');
  const replay = await api(`${reserved.candidateId}/apply`, body); expect(replay.status).toBe(200); expect(replay.data.id).toBe(first.data.id); expect(replay.data.appliedCommit).toBe(reserved.candidateCommit);
  expect(git(source, 'rev-parse', 'HEAD')).toBe(later); expect(applying()).toHaveLength(1);
});
it('적용한 후보에 다른 키로 다시 쓰지 않고 같은 키의 다른 body도 거부한다', async () => {
  await ready(); const body = await input(); expect((await api(`${reserved.candidateId}/apply`, body)).status).toBe(200);
  expect((await api(`${reserved.candidateId}/apply`, { ...body, requestKey: 'different' })).status).toBe(409);
  expect((await api(`${reserved.candidateId}/apply`, { ...body, expectedVersion: '0'.repeat(64) })).status).toBe(409);
  expect(applying()).toHaveLength(1); expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.candidateCommit);
});
it('별도 Store의 동시 확정은 영속 integration scope 아래 실제 ff를 한 번만 실행한다', async () => {
  await ready(); const body = await input(); const other = await createApplication(); await other.listen(0, '127.0.0.1');
  const run = runner.runGit; let count = 0;
  vi.spyOn(runner, 'runGit').mockImplementation((root, args, options, optional) => { if (ff(args)) count++; return run(root, args, options, optional); });
  try {
    const remote = async () => { const response = await fetch(`${await other.getUrl()}/api/work/a/integration/${reserved.candidateId}/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, requestKey: 'second-store' }) }); return response.status; };
    const results = await Promise.all([api(`${reserved.candidateId}/apply`, body), remote()]);
    expect(results.map(result => typeof result === 'number' ? result : result.status).sort()).toEqual([200, 409]); expect(count).toBe(1); expect(applying()).toHaveLength(1);
  } finally { await other.close(); }
});
it('마지막 proof fence 이전 대상 변경은 intent 없이 거부한다', async () => {
  await ready(); const body = await input(), preflight = app.get(IntegrationApplyPreflight), capture = preflight.capture.bind(preflight); let moved = false;
  vi.spyOn(preflight, 'capture').mockImplementation(async (...args: any[]) => { const proof = await capture(...args); if (!moved) { moved = true; git(source, 'commit', '--allow-empty', '-m', 'source raced'); } return proof; });
  const response = await api(`${reserved.candidateId}/apply`, body); expect(response.status).toBe(409); expect(response.data.mutationOutcome).toBe('rejected-before-intent'); expect(applying()).toEqual([]); expect(git(source, 'rev-parse', 'HEAD')).not.toBe(reserved.candidateCommit);
});
it('원본 ignored 파일과 후보의 새 tracked 파일이 겹치면 로컬 파일을 보존한다', async () => {
  writeFileSync(join(work.executionPath!, 'ignored-local.txt'), 'candidate tracked'); git(work.executionPath!, 'add', '--force', '--', 'ignored-local.txt'); await ready();
  writeFileSync(join(source, 'ignored-local.txt'), 'original private'); await certify(); const body = await input(), before = git(source, 'rev-parse', 'HEAD');
  const response = await api(`${reserved.candidateId}/apply`, body); expect(response.status).toBe(200); expect(response.data.status).toBe('failed'); expect(response.data.applied).toBe(false);
  expect(readFileSync(join(source, 'ignored-local.txt'), 'utf8')).toBe('original private'); expect(git(source, 'rev-parse', 'HEAD')).toBe(before); expect(applying()).toHaveLength(1);
});
it('프로젝트 hooks·fsmonitor·autostash 설정은 ff 실행에 사용하지 않는다', async () => {
  await ready(); const hooks = join(dirname(source), 'hooks'); mkdirSync(hooks); const hookMarker = join(dirname(source), 'hook-ran'), fsMarker = join(dirname(source), 'monitor-ran');
  writeFileSync(join(hooks, 'post-merge'), '#!/bin/sh'+String.fromCharCode(10)+`echo ran > '${hookMarker.split(String.fromCharCode(92)).join('/')}'`+String.fromCharCode(10));
  git(source, 'config', 'core.hooksPath', hooks); git(source, 'config', 'core.fsmonitor', `echo ran > '${fsMarker.split(String.fromCharCode(92)).join('/')}'`); git(source, 'config', 'merge.autostash', 'true'); git(source, 'config', 'maintenance.auto', 'true');
  await certify(); const body = await input(), response = await api(`${reserved.candidateId}/apply`, body);
  expect(response.status).toBe(200); expect(response.data.status).toBe('applied'); expect(existsSync(hookMarker)).toBe(false); expect(existsSync(fsMarker)).toBe(false); expect(git(source, 'stash', 'list')).toBe('');
});
it.each(['before', 'after'])('ff %s 실패도 intent·실제 HEAD를 보존하고 같은 키로 실행을 반복하지 않는다', async stage => {
  await ready(); const body = await input(), run = runner.runGit; let count = 0;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    if (!ff(args)) return run(root, args, options, optional);
    count++; if (stage === 'before') throw new runner.GitError('injected before ff', 400);
    await run(root, args, options, optional); throw new runner.GitError('injected after ff response', 409, true, false);
  });
  const response = await api(`${reserved.candidateId}/apply`, body); expect(response.status).toBe(200);
  expect(response.data.observedHead).toBe(stage === 'before' ? reserved.targetHead : reserved.candidateCommit);
  expect(response.data.status).toBe(stage === 'before' ? 'failed' : 'applied'); expect(response.data.processTerminated).toBe(true);
  const replay = await api(`${reserved.candidateId}/apply`, body); expect(replay.status).toBe(200); expect(replay.data.id).toBe(response.data.id); expect(count).toBe(1); expect(applying()).toHaveLength(1);
});
it('Git 반영 뒤 DB 저장 실패는 실제 적용을 숨기거나 새 키로 반복하지 않는다', async () => {
  await ready(); const body = await input(), record = store.record.bind(store); let failed = false;
  vi.spyOn(store, 'record').mockImplementation((id, workId, kind, data: any) => { if (!failed && kind === 'integration-apply' && data.status === 'applied') { failed = true; throw new Error('lost apply publication'); } return record(id, workId, kind, data); });
  await api(`${reserved.candidateId}/apply`, body); expect(failed).toBe(true); expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.candidateCommit);
  expect(applying()[0].status).not.toBe('failed'); const replay = await api(`${reserved.candidateId}/apply`, body); expect(replay.status).toBe(200); expect(replay.data.id).toBe(applying()[0].id); expect(applying()).toHaveLength(1);
});
it('A 적용 뒤 기존 독립 B 업무를 최신 원본과 결합하여 순서대로 반영한다', async () => {
  const settings = app.get(WorkspaceSettingsService), original = work;
  const docs = join(source, 'openspec/changes/b'); mkdirSync(join(docs, 'specs/demo'), { recursive: true });
  for (const path of ['proposal.md', 'design.md', 'tasks.md', 'specs/demo/spec.md']) writeFileSync(join(docs, path), '# B plan');
  git(source, 'add', '--', 'openspec/changes/b'); git(source, 'commit', '-m', 'B docs fixture');
  const b: Work = { ...work, id: 'b', requestKey: 'b', changeName: 'b', workspace: undefined, executionPath: undefined }; store.save(b); const head = git(source, 'rev-parse', 'HEAD');
  await new WorktreeManager({ store }).create(b, settings, { requestKey: 'create-b', selectedBranch: 'main', baseCommit: head, sourceHead: head });
  b.workspace!.status = 'ready'; b.workspace!.workspaceBaselineCommit = head; b.workspace!.sourcePlanRevision = collectWorkspaceDocuments(source, 'b').planRevision; store.save(b); b.reviewedVersion = works.planVersion(b); store.save(b);
  work = original; await ready(); const aCommit = reserved.candidateCommit, first = await api(`${reserved.candidateId}/apply`, await input('apply-a')); expect(first.data.status).toBe('applied');
  work = b; await ready(); const second = await api(`${reserved.candidateId}/apply`, await input('apply-b')); expect(second.data.status).toBe('applied');
  expect(git(source, 'merge-base', '--is-ancestor', aCommit, 'HEAD')).toBe(''); expect(readFileSync(join(source, 'result-a.txt'), 'utf8')).toBe('result-a'); expect(readFileSync(join(source, 'result-b.txt'), 'utf8')).toBe('result-b');
});
it.each(['shared', 'worktree'])('원본 %s core.worktree 변조는 바깥 폴더에 쓰지 않고 차단한다', async kind => {
  await ready(); const body = await input(), outside = join(dirname(source), 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'preserved.txt'), 'external private');
  if (kind === 'shared') git(source, 'config', 'core.worktree', outside);
  else { git(source, 'config', 'extensions.worktreeConfig', 'true'); git(source, 'config', '--worktree', 'core.worktree', outside); }
  expect(git(source, 'rev-parse', '--show-toplevel').replaceAll('\\', '/')).toBe(outside.replaceAll('\\', '/'));
  const response = await api(`${reserved.candidateId}/apply`, body); expect(response.status).toBe(409); expect(response.data.mutationOutcome).toBe('rejected-before-intent');
  expect(applying()).toEqual([]); expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.targetHead); expect(existsSync(join(source, 'result-a.txt'))).toBe(false);
  expect(readdirSync(outside)).toEqual(['preserved.txt']); expect(readFileSync(join(outside, 'preserved.txt'), 'utf8')).toBe('external private');
});
it('원본 전용 attributesFile의 후보 새 경로 smudge는 쓰기 전에 차단한다', async () => {
  await ready(); const marker = join(dirname(source), 'source-smudge-ran'), attributes = join(dirname(source), 'source-attributes');
  writeFileSync(attributes, 'result-a.txt filter=source-only' + String.fromCharCode(10));
  git(source, 'config', 'extensions.worktreeConfig', 'true'); git(source, 'config', '--worktree', 'core.attributesFile', attributes);
  git(source, 'config', 'filter.source-only.smudge', `echo ran > '${marker.split(String.fromCharCode(92)).join('/')}'; cat`);
  await certify(); const body = await input(), response = await api(`${reserved.candidateId}/apply`, body);
  expect(existsSync(marker)).toBe(false); expect(response.status).toBe(409); expect(response.data.mutationOutcome).toBe('rejected-before-intent');
  expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.targetHead); expect(existsSync(join(source, 'result-a.txt'))).toBe(false); expect(applying()).toEqual([]);
});
it('최종 fence 뒤 checkout 경쟁이 있어도 다른 브랜치 ref를 전진시키지 않는다', async () => {
  await ready(); const body = await input(), run = runner.runGit; let injected = false, switched = false;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => {
    if (ff(args) && !injected) {
      injected = true; try { git(source, 'checkout', '-b', 'outside-branch', reserved.targetHead); switched = true; } catch { /* A held source HEAD lease must reject this external checkout. */ }
    }
    return run(root, args, options, optional);
  });
  const response = await api(`${reserved.candidateId}/apply`, body); expect(injected).toBe(true);
  expect(git(source, 'rev-parse', 'refs/heads/outside-branch')).toBe(reserved.targetHead);
  if (switched) { expect(response.data.applied).toBe(false); expect(git(source, 'rev-parse', 'refs/heads/main')).toBe(reserved.targetHead); }
  else { expect(response.data.status).toBe('applied'); expect(git(source, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main'); expect(git(source, 'rev-parse', 'refs/heads/main')).toBe(reserved.candidateCommit); }
});
it('native pin 안에서 마지막 fence 뒤 checkout을 거부하고 main만 적용한다', async () => {
  await ready(); const body = await input(), run = runner.runGit; let blocked = false;
  vi.spyOn(runner, 'runGit').mockImplementation((root, args, options, optional) => {
    if (ff(args) && options?.headPin) {
      const fence = options.headPin.beforeDispatch;
      options = { ...options, headPin: { ...options.headPin, beforeDispatch: async () => { await fence(); try { git(source, 'checkout', '-b', 'pinned-other', reserved.targetHead); } catch { blocked = true; } } } };
    }
    return run(root, args, options, optional);
  });
  const response = await api(`${reserved.candidateId}/apply`, body); expect(blocked).toBe(true); expect(response.data.status).toBe('applied');
  expect(git(source, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main'); expect(git(source, 'rev-parse', 'refs/heads/main')).toBe(reserved.candidateCommit); expect(git(source, 'rev-parse', 'refs/heads/pinned-other')).toBe(reserved.targetHead);
});
it('Git 종료 뒤 외부 index와 파일 변경은 자동 복구 없이 uncertain으로 보존한다', async () => {
  await ready(); const body = await input(), run = runner.runGit;
  vi.spyOn(runner, 'runGit').mockImplementation(async (root, args, options, optional) => { const result = await run(root, args, options, optional); if (ff(args)) { writeFileSync(join(source, 'result-a.txt'), 'external writer'); git(source, 'add', '--', 'result-a.txt'); } return result; });
  const response = await api(`${reserved.candidateId}/apply`, body); expect(response.data.status).toBe('uncertain'); expect(response.data.applied).toBe(false); expect(response.data.observedHead).toBe(reserved.candidateCommit);
  expect(readFileSync(join(source, 'result-a.txt'), 'utf8')).toBe('external writer'); expect(git(source, 'diff', '--cached', '--name-only')).toBe('result-a.txt');
  expect(store.records('a', 'workspace-git-intent').some(row => row.stage === 'integration-apply' && row.status === 'uncertain')).toBe(true);
});
it('대기 worker PID 저장 실패는 Git을 dispatch하지 않는다', async () => {
  await ready(); const body = await input(), record = store.record.bind(store); let failed = false;
  vi.spyOn(store, 'record').mockImplementation((id, workId, kind, data: any) => { if (!failed && kind === 'integration-apply' && data.processId && data.status === 'running' && !data.commandStarted) { failed = true; throw new Error('waiting PID receipt failed'); } return record(id, workId, kind, data); });
  const response = await api(`${reserved.candidateId}/apply`, body); expect(failed).toBe(true); expect(response.data.processTerminated).toBe(true); expect(response.data.commandStarted).not.toBe(true);
  expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.targetHead); expect(existsSync(join(source, 'result-a.txt'))).toBe(false); expect(app.get(DesktopLifecycle).requests).toBe(0);
});
it('구형 두 인자 guard는 HEAD pin 준비로 오인하지 않고 Git을 시작하지 않는다', async () => {
  await ready(); const body = await input(), directory = join(dirname(source), 'old-runtime'); mkdirSync(join(directory, 'guard'), { recursive: true });
  const compiler = join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/target:exe', '/out:'+join(directory, 'guard/BrowserGuard.exe'), fileURLToPath(new URL('./fixtures/BrowserGuard-v1.cs', import.meta.url))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const saved = process.env.OPENSPEC_BROWSER_DIRECTORY; process.env.OPENSPEC_BROWSER_DIRECTORY = directory;
  try {
    const response = await api(`${reserved.candidateId}/apply`, body); expect(response.data.applied).toBe(false); expect(response.data.commandStarted).not.toBe(true); expect(response.data.processTerminated).toBe(true);
    expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.targetHead); expect(existsSync(join(source, 'result-a.txt'))).toBe(false);
  } finally { if (saved === undefined) delete process.env.OPENSPEC_BROWSER_DIRECTORY; else process.env.OPENSPEC_BROWSER_DIRECTORY = saved; }
});
it('ff 진입 직전 혼합case Git index env도 원본 밖 index를 쓰지 못한다', async () => {
  await ready(); const body = await input(), outside = join(dirname(source), 'outside-index'), index = git(source, 'rev-parse', '--path-format=absolute', '--git-path', 'index'); copyFileSync(index, outside);
  const digest = () => createHash('sha256').update(readFileSync(outside)).digest('hex'), before = digest(), run = runner.runGit;
  const priorKey = Object.keys(process.env).find(key => key.toUpperCase() === 'GIT_INDEX_FILE'), priorValue = priorKey ? process.env[priorKey] : undefined; let injected = false;
  vi.spyOn(runner, 'runGit').mockImplementation((root, args, options, optional) => {
    if (ff(args) && !injected) { injected = true; delete process.env.GIT_INDEX_FILE; process.env.git_index_file = outside; }
    return run(root, args, options, optional);
  });
  try {
    const response = await api(`${reserved.candidateId}/apply`, body); expect(injected).toBe(true); expect(digest()).toBe(before); expect(response.data.status).toBe('applied');
  } finally { delete process.env.GIT_INDEX_FILE; delete process.env.git_index_file; if (priorKey && priorValue !== undefined) process.env[priorKey] = priorValue; }
  expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.candidateCommit); expect(git(source, 'diff', '--cached', '--name-only')).toBe('');
});


it('복합 장애 전체 흐름은 질문·원본·부분 파일을 보존하고 생성·반영·제거를 중복 실행하지 않는다', async () => {
  // beforeEach/ready retain trusted document/verification seeds; mutations below
  // use actual Git, SQLite, native Job and app HTTP, without an AI/model call.
  const settings = app.get(WorkspaceSettingsService), root = dirname(source), rootA = work.workspace!.rootPath, aPath = work.executionPath!;
  const spaces = new WorkspaceService(store, { protectedPaths: () => settings.protectedPaths() });
  const question = { kind: 'input', status: 'pending', prompt: '설정 전환 동안 보존', threadId: work.threadId };
  store.record('fault-question', work.id, 'question', question);
  const questionBefore = store.records(work.id, 'question'), originalHead = git(source, 'rev-parse', 'HEAD');
  const selected = settings.read(), check = settings.check({ version: selected.version, path: join(root, 'second-root') });
  settings.save({ version: selected.version, token: check.token, confirmed: true });
  const b: Work = { ...work, id: 'fault-b', changeName: 'fault-b', requestKey: 'fault-b', threadId: 'fault-thread-b', workspace: undefined, executionPath: undefined, phase: 'reviewed' }; store.save(b);
  let creates = 0;
  const broken = new WorktreeManager({ store, run: async (path, args) => {
    const output = await runner.runGit(path, args, args.includes('worktree') && args.includes('add') ? { ownedJob: true } : {});
    if (args.includes('worktree') && args.includes('add') && ++creates === 1) throw new Error('lost create response');
    return output;
  } });
  const creation = { requestKey: 'fault-create', selectedBranch: 'main', baseCommit: originalHead, sourceHead: originalHead };
  try { await expect(broken.create(b, settings, creation)).rejects.toThrow('lost create response'); } finally { await broken.close(); }
  const bPath = store.get(b.id)!.executionPath!;
  await new WorktreeManager({ store }).create(store.get(b.id)!, settings, creation);
  expect(store.get(b.id)?.executionPath).toBe(bPath); expect(creates).toBe(1);
  expect(git(source, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(3);
  const offline = join(root, 'offline-a'); expect(dirname(rootA)).toBe(root); expect(dirname(offline)).toBe(root);
  renameSync(rootA, offline);
  try {
    expect(() => spaces.path(store.get(work.id)!)).toThrow(/복구/);
    expect(store.get(work.id)).toMatchObject({ executionPath: aPath, threadId: 'fixture' });
    expect(store.records(work.id, 'question')).toEqual(questionBefore);
    expect(existsSync(bPath)).toBe(true); expect(git(source, 'rev-parse', 'HEAD')).toBe(originalHead);
  } finally { renameSync(offline, rootA); }
  expect(spaces.path(store.get(work.id)!)).toBe(aPath);
  let free = 1000; const partial = join(bPath, 'partial-install.txt');
  const capacity = new WorkspacePreparation(store, { policy: () => ({ maxActiveWorks: 3, minimumFreeBytes: 100, retentionDays: 14 }), freeBytes: () => free });
  await expect(capacity.run(store.get(b.id)!, bPath, 'install', async () => { writeFileSync(partial, 'keep partial'); free = 0; })).rejects.toThrow(/용량/);
  expect(() => spaces.path(store.get(b.id)!)).toThrow(/복구/); expect(store.records(b.id, 'isolated-baseline')).toHaveLength(0);
  expect(store.records(work.id, 'question')).toEqual(questionBefore);
  // Explicit fixture answer ends the pending question; no automatic reply/replay.
  store.record('fault-question', work.id, 'question', { ...question, status: 'answered', answer: 'continue fixture' });
  await ready(); const body = await input('fault-apply'), actual = runner.runGit; let applied = 0;
  let spy = vi.spyOn(runner, 'runGit').mockImplementation(async (path, args, options, optional) => {
    const output = await actual(path, args, options, optional);
    if (ff(args)) { applied++; throw new runner.GitError('lost ff response', 409, true, false); }
    return output;
  });
  const response = await api(reserved.candidateId + '/apply', body); expect(response.data).toMatchObject({ status: 'applied', processTerminated: true });
  expect((await api(reserved.candidateId + '/apply', body)).data.id).toBe(response.data.id); expect(applied).toBe(1); spy.mockRestore();
  expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.candidateCommit);
  // Seed only the already separately verified completion capture to isolate
  // removal failure from the completion UI contract covered by actual IAB.
  const completed = store.get(work.id)!; new CompletedResults(store).capture(completed, { files: [], source: 'completed' }, []); completed.phase = 'completed'; completed.state = 'idle'; store.save(completed);
  const cleanup = new WorkspaceCleanup(store, settings), preview = await cleanup.preview(work.id);
  expect(preview.canRemove, JSON.stringify(preview.blockers)).toBe(true);
  const removal = { requestKey: randomUUID(), token: preview.token, expectedVersion: preview.version, confirmed: true };
  const retained = new CompletedResults(store).header(work.id).retained.captureId, userFile = join(dirname(aPath), 'new-user-file.txt'); let removes = 0;
  spy = vi.spyOn(runner, 'runGit').mockImplementation(async (path, args, options, optional) => {
    const output = await actual(path, args, options, optional);
    if (args.includes('worktree') && args.includes('remove')) { removes++; writeFileSync(userFile, 'keep concurrent file'); }
    return output;
  });
  const result = await cleanup.remove(work.id, removal); expect(result).toMatchObject({ status: 'uncertain', processTerminated: true });
  expect(await cleanup.remove(work.id, removal)).toEqual(result); expect(removes).toBe(1); spy.mockRestore();
  expect(readFileSync(userFile, 'utf8')).toBe('keep concurrent file'); expect(readFileSync(partial, 'utf8')).toBe('keep partial');
  expect(new CompletedResults(store).header(work.id).retained.captureId).toBe(retained);
  expect(git(source, 'rev-parse', 'HEAD')).toBe(reserved.candidateCommit); expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('base\n');
  expect(git(source, 'show-ref', '--verify', 'refs/heads/' + work.workspace!.branch)).toBeTruthy();
  expect(store.records(work.id, 'integration-apply')).toHaveLength(1); expect(store.records(work.id, 'workspace-cleanup')).toHaveLength(1);
  expect(store.get(work.id)?.threadId).toBe('fixture'); expect(store.get(b.id)?.threadId).toBe('fault-thread-b');
}, 180000);
