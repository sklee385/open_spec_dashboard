import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/app';
import { WorkStore, type Work, type IntegrationRequest } from '../src/work/store';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorktreeManager } from '../src/work/worktree-manager';
import { IntegrationService } from '../src/work/integration.service';
import { candidateBranch, candidateIdentity } from '../src/work/integration-candidate';
vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const replacePointer = (path: string, content: string) => { const fd = openSync(path, 'r+'); try { ftruncateSync(fd); writeFileSync(fd, content); } finally { closeSync(fd); } };
let app: any, base: string, source: string, work: Work, store: WorkStore, candidate: IntegrationRequest;
const saved = { CONFIG_PATH: process.env.CONFIG_PATH, DATA_DIR: process.env.DATA_DIR, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
async function api(endpoint: string, method = 'GET', body?: unknown, scope = `workId=a&candidateId=${candidate.candidateId}`, sourceId = 'demo') {
  const r = await fetch(`${base}/api/projects/${sourceId}/${endpoint}${endpoint.includes('?') ? '&' : '?'}${scope}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, data: await r.json() };
}
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-')); source = join(dir, 's'); mkdirSync(join(source, 'openspec'), { recursive: true }); mkdirSync(join(dir, 'c'));
  git(source, 'init', '-b', 'main'); git(source, 'config', 'core.autocrlf', 'false'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(join(source, 'code.txt'), 'original'); git(source, 'add', '--all'); git(source, 'commit', '-m', 'base');
  process.env.CONFIG_PATH = join(dir, 'c/config.json'); process.env.DATA_DIR = join(dir, 'd'); delete process.env.WORKSPACE_ROOT;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(source, 'openspec') }, { name: 'other', path: join(source, 'openspec') }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl(); store = app.get(WorkStore);
  const settings = app.get(WorkspaceSettingsService), current = settings.read(), check = settings.check({ version: current.version, path: join(dir, 'r') }); settings.save({ version: current.version, token: check.token, confirmed: true });
  work = { id: 'a', sourceId: 'demo', projectPath: source, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'verification', state: 'idle', threadId: 'fixture', reviewedVersion: 'plan', createdAt: '', updatedAt: '' }; store.save(work);
  const head = git(source, 'rev-parse', 'HEAD'); await new WorktreeManager({ store }).create(work, settings, { requestKey: 'create', selectedBranch: 'main', baseCommit: head, sourceHead: head });
  work.workspace!.status = 'ready'; work.workspace!.workspaceBaselineCommit = head; work.workspace!.localOnlyPaths = ['local.txt']; store.save(work);
  candidate = app.get(IntegrationService).reserve({ requestKey: 'integration', confirmed: true, targetBranch: 'main', expectedWorkHead: head, expectedTargetHead: head, reviewedVersion: 'plan' }, { work, sourceRevision: 'fixture', workVerificationRefs: [] });
  candidate.resultCommit = head; candidate.resultTree = git(source, 'rev-parse', 'HEAD^{tree}');
  mkdirSync(join(candidate.executionPath, '..'), { recursive: true }); writeFileSync(join(candidate.executionPath, '..', 'identity.json'), JSON.stringify(candidateIdentity(candidate)));
  git(source, 'worktree', 'add', '-b', candidateBranch(candidate), candidate.executionPath, head);
  writeFileSync(join(candidate.executionPath, 'candidate.txt'), 'candidate only'); git(candidate.executionPath, 'add', '--all'); git(candidate.executionPath, 'commit', '-m', 'candidate');
  candidate.candidateCommit = git(candidate.executionPath, 'rev-parse', 'HEAD'); candidate.status = 'validating'; store.record(candidate.id, work.id, 'integration-request', candidate);
});
afterEach(async () => { await app?.close(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
it('후보 query는 모든 조회 route와 대상 기준 metadata에 같은 소유 root를 전달한다', async () => {
  for (const endpoint of ['tree', 'search?q=candidate', 'entry?path=candidate.txt', 'file?path=candidate.txt', 'git/status', 'git/branches', 'git/log', `git/commits/${candidate.candidateCommit}`, `git/commits/${candidate.candidateCommit}/file?path=candidate.txt`, 'git/diff?path=candidate.txt&side=unstaged']) expect((await api(endpoint)).status, endpoint).toBe(200);
  const metadata = await api('workspace'); expect(metadata.data).toMatchObject({ kind: 'integration-candidate', candidateId: candidate.candidateId, executionPath: candidate.executionPath, workspaceBaselineCommit: candidate.targetHead, head: candidate.candidateCommit, changedPaths: ['candidate.txt'], readOnly: false, gitReadOnly: true, editContract: 'candidate-cas' });
  expect((await api('file?path=candidate.txt')).data.content).toBe('candidate only'); expect((await api('file?path=code.txt', 'GET', undefined, '')).data.content).toBe('original'); expect((await api('file?path=code.txt', 'GET', undefined, 'workId=a')).data.content).toBe('original');
  expect((await api('git/operations/unknown')).status).toBe(404);
});
it.each([['file', 'PUT', { path: 'code.txt', content: 'wrong', version: 'x' }], ['entries', 'POST', { path: 'wrong.txt', kind: 'file' }], ['entries/move', 'POST', { path: 'code.txt', target: 'wrong.txt' }], ['file', 'DELETE', { path: 'code.txt' }], ['git/operations', 'POST', { kind: 'stage', paths: ['code.txt'], token: 'x', requestKey: 'x' }], ['git/operations/x/reconcile', 'POST', { confirmed: true }]] as const)('준비 근거·후보 CAS 없는 %s %s 쓰기는 거부하고 모든 root를 보존한다', async (endpoint, method, body) => {
  const before = [source, work.executionPath!, candidate.executionPath].map(root => git(root, 'status', '--porcelain') + git(root, 'rev-parse', 'HEAD'));
  const response = await api(endpoint, method, body); expect([400, 409]).toContain(response.status); expect(response.data.message).toMatch(/읽기|준비|버전|CAS|확인/);
  expect([source, work.executionPath!, candidate.executionPath].map(root => git(root, 'status', '--porcelain') + git(root, 'rev-parse', 'HEAD'))).toEqual(before);
});
it.each(['queued', 'preparing', 'failed', 'uncertain', 'cancelled', 'removed', 'applied', 'applying'])('후보 %s 상태는 다른 root로 fallback하지 않는다', async status => {
  store.record(candidate.id, work.id, 'integration-request', { ...candidate, status }); expect((await api('file?path=code.txt')).status).toBe(409);
});
it('다른 project/work/candidate와 손상된 marker/HEAD를 거부한다', async () => {
  expect((await api('file?path=code.txt', 'GET', undefined, `candidateId=${candidate.candidateId}`)).status).toBe(404);
  expect((await api('file?path=code.txt', 'GET', undefined, `workId=foreign&candidateId=${candidate.candidateId}`)).status).toBe(404);
  expect((await api('file?path=code.txt', 'GET', undefined, undefined, 'other')).status).toBe(404);
  expect((await api('file?path=code.txt', 'GET', undefined, 'workId=a&candidateId=00000000-0000-0000-0000-000000000000')).status).toBe(404);
  const marker = join(candidate.executionPath, '..', 'identity.json'), original = readFileSync(marker, 'utf8'); writeFileSync(marker, original.replace('integration-candidate', 'foreign'));
  expect((await api('file?path=code.txt')).status).toBe(409); writeFileSync(marker, original);
  git(candidate.executionPath, 'reset', '--hard', candidate.targetHead); expect((await api('file?path=code.txt')).status).toBe(409);
});
it('후보에도 비밀·로컬 전용·독립 파일 정책을 적용한다', async () => {
  writeFileSync(join(candidate.executionPath, '.env'), 'SECRET=fixture'); writeFileSync(join(candidate.executionPath, 'local.txt'), 'local');
  expect((await api('file?path=.env')).status).toBe(403); expect((await api('file?path=local.txt')).status).toBe(403);
  linkSync(join(candidate.executionPath, 'code.txt'), join(candidate.executionPath, 'linked.txt')); expect((await api('file?path=linked.txt')).status).toBe(403);
});
it.each(['workspaceId', 'projectId', 'executionPath', 'rootId'])('후보의 %s 관계 변조를 거부한다', async field => {
  store.record(candidate.id, work.id, 'integration-request', { ...candidate, [field]: field === 'executionPath' ? work.executionPath : 'invalid' });
  expect((await api('file?path=code.txt')).status).toBe(409);
});
it('저장된 후보 root는 설정 변경 뒤에도 유지하며 pointer·branch 변조는 거부한다', async () => {
  const settings = app.get(WorkspaceSettingsService), current = settings.read(), check = settings.check({ version: current.version, path: join(source, '..', 'r2') }); settings.save({ version: current.version, token: check.token, confirmed: true });
  store.record(candidate.id, work.id, 'integration-request', { ...candidate, status: 'ready' });
  expect((await api('workspace')).data.executionPath).toBe(candidate.executionPath);
  const pointer = join(candidate.executionPath, '.git'), original = readFileSync(pointer, 'utf8');
  replacePointer(pointer, readFileSync(join(work.executionPath!, '.git'), 'utf8')); expect((await api('file?path=code.txt')).status).toBe(409); replacePointer(pointer, original);
  git(candidate.executionPath, 'checkout', '--detach'); expect((await api('file?path=code.txt')).status).toBe(409);
});
it('소유 MERGE_HEAD와 target HEAD가 일치하는 충돌 후보만 읽고 수정은 거부한다', async () => {
  writeFileSync(join(source, 'code.txt'), 'target'); git(source, 'add', '--all'); git(source, 'commit', '-m', 'target');
  writeFileSync(join(work.executionPath!, 'code.txt'), 'work'); git(work.executionPath!, 'add', '--all'); git(work.executionPath!, 'commit', '-m', 'work');
  candidate.targetHead = git(source, 'rev-parse', 'HEAD'); candidate.resultCommit = git(work.executionPath!, 'rev-parse', 'HEAD'); candidate.candidateCommit = null; candidate.status = 'conflicted';
  git(candidate.executionPath, 'reset', '--hard', candidate.targetHead);
  expect(() => git(candidate.executionPath, 'merge', '--no-ff', '--no-commit', candidate.resultCommit!)).toThrow();
  writeFileSync(join(candidate.executionPath, '..', 'identity.json'), JSON.stringify(candidateIdentity(candidate))); store.record(candidate.id, work.id, 'integration-request', candidate);
  expect((await api('file?path=code.txt')).status).toBe(200); expect((await api('git/status')).data.progress.kind).toBe('merge');
  expect((await api('git/operations', 'POST', { kind: 'stage', paths: ['code.txt'], token: 'x', requestKey: 'x' })).status).toBe(409);
  const mergePath = git(candidate.executionPath, 'rev-parse', '--git-path', 'MERGE_HEAD'); writeFileSync(resolve(candidate.executionPath, mergePath), candidate.targetHead + '\n');
  expect((await api('file?path=code.txt')).status).toBe(409);
});
it.each(['merge', 'rebase', 'continue-pull', 'abort-pull'])('기존 원본·업무의 %s 일반 Git 요청 거부를 유지한다', async kind => {
  for (const scope of ['', 'workId=a']) expect((await api('git/operations', 'POST', { kind, requestKey: 'forbidden', token: 'x' }, scope)).status).toBeGreaterThanOrEqual(400);
});
it.each(['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'MERGE_AUTOSTASH', 'rebase-merge'])('HEAD가 같아도 외부 %s 진행 표시를 후보로 채택하거나 정리하지 않는다', async marker => {
  const dir = git(candidate.executionPath, 'rev-parse', '--absolute-git-dir'), path = join(dir, marker), head = git(candidate.executionPath, 'rev-parse', 'HEAD');
  if (['sequencer', 'rebase-merge'].includes(marker)) mkdirSync(path); else writeFileSync(path, head + '\n');
  expect((await api('file?path=code.txt')).status).toBe(409); expect((await api('git/status')).status).toBe(409);
  expect((await api('file', 'PUT', { path: 'code.txt', content: 'wrong', version: 'f'.repeat(64) })).status).toBe(409); expect(git(candidate.executionPath, 'rev-parse', 'HEAD')).toBe(head);
  expect(['sequencer', 'rebase-merge'].includes(marker) ? existsSync(path) : readFileSync(path, 'utf8')).toBe(['sequencer', 'rebase-merge'].includes(marker) ? true : head + '\n');
});
