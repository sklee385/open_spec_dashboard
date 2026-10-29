import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  store.record(`verified-${id}`, id, 'verification', { commandId: command.id, scope: 'full', status: 'passed', revision: works.execution.revision(work), sourceMutationVersion: work.sourceMutationVersion, commandVersion: JSON.stringify(command) });
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
it('실제 Git 근거와 별도 후보 경로를 queued로 저장하고 동일 요청을 먼저 재조회한다', async () => {
  store.record('retired-command', 'a', 'verification', { commandId: 'retired', scope: 'full', status: 'passed', revision: works.execution.revision(a) });
  store.record('retired-browser', 'a', 'browser-verification', { status: 'passed' });
  const before = git(source, 'worktree', 'list', '--porcelain'); const result = await request('a', body);
  expect(result.status).toBe(200); expect(result.data).toMatchObject({ workId: 'a', requestKey: body.requestKey, workHead: body.expectedWorkHead, targetHead: body.expectedTargetHead, targetBranch: 'main', status: 'queued', verificationRefs: [], candidateCommit: null });
  expect(result.data.executionPath).toContain(join('integrations', result.data.candidateId, 'project')); expect(result.data.executionPath).not.toBe(a.executionPath); expect(existsSync(result.data.executionPath)).toBe(false); expect(git(source, 'worktree', 'list', '--porcelain')).toBe(before);
  expect(result.data.workVerificationRefs).toEqual(['verified-a']); expect(store.get('a')?.threadId).toBe('thread-a');
  git(source, 'commit', '--allow-empty', '-m', 'changed target'); a.reviewedVersion = null; store.save(a); select(join(root, 'r2'));
  expect(await request('a', body)).toEqual(result); expect((await request('a', { ...body, targetBranch: 'other' })).status).toBe(409);
  const query = await request('a'); expect(query.data.requests).toHaveLength(1); expect(query.data.active.candidateId).toBe(result.data.candidateId);
});
it('다른 등록 프로젝트·업무의 같은 공통 저장소 요청과 동시 요청을 하나로 제한한다', async () => {
  const b = await fixture('b'); b.sourceId = 'other'; store.save(b);
  const responses = await Promise.all([request('a', body), request('b', input(b, 'b-request'))]);
  expect(responses.map(row => row.status).sort()).toEqual([200, 409]); expect(store.list().flatMap(work => store.records(work.id, 'integration-request'))).toHaveLength(1);
  const owner = responses[0].status === 200 ? 'a' : 'b', ownerBody = owner === 'a' ? body : input(b, 'b-request');
  const again = await Promise.all([request(owner, ownerBody), request(owner, ownerBody)]); expect(again[0]).toEqual(again[1]);
});
it('최신 업무 검증·계획과 실제 HEAD·소유 경계 및 명시적 요청을 요구한다', async () => {
  for (const changed of [{ expectedWorkHead: '0'.repeat(40) }, { expectedTargetHead: '0'.repeat(40) }, { reviewedVersion: 'old' }, { confirmed: false }, { targetBranch: '--upload-pack=bad' }, { path: source }]) expect((await request('a', { ...body, ...changed, requestKey: 'check-' + Object.keys(changed)[0] })).status).toBeGreaterThanOrEqual(400);
  store.record('verified-a', 'a', 'verification', { status: 'failed' }); expect((await request('a', body)).status).toBe(409); expect(store.records('a', 'integration-request')).toHaveLength(0);
  expect((await request('missing')).status).toBe(404);
});
it('현재 확인 루트를 후보에 고정하고 이전 업무 경로와 참조를 보존한다', async () => {
  const old = a.executionPath; select(join(root, 'r2')); const selected = settings.read(); const result = await request('a', body);
  expect(result.status).toBe(200); expect(result.data.rootId).toBe(selected.selectedRootId); expect(result.data.executionPath.startsWith(join(root, 'r2'))).toBe(true); expect(store.get('a')?.executionPath).toBe(old); expect(store.rootReferences(result.data.rootId, join(root, 'r2'))).toContainEqual(expect.objectContaining({ kind: 'integration-request' }));
});
it('실패·uncertain 후보도 슬롯을 유지하고 terminal 기록은 새 요청 뒤에도 남는다', async () => {
  const initial = await request('a', body); expect(initial.status).toBe(200); const b = await fixture('b');
  for (const status of ['failed', 'uncertain']) { store.record(initial.data.id, 'a', 'integration-request', { ...initial.data, status }); expect((await request('b', input(b, `b-${status}`))).status).toBe(409); }
  store.record(initial.data.id, 'a', 'integration-request', { ...initial.data, status: 'applied', appliedCommit: body.expectedTargetHead }); const next = await request('b', input(b, 'next')); expect(next.status).toBe(200); expect(store.records('a', 'integration-request')[0].status).toBe('applied');
});
it('새 서비스·DB 연결도 멱등 결과와 저장소별 슬롯을 다시 읽는다', async () => {
  const b = await fixture('b'), readiness = await works.integrationReadiness('b', b.reviewedVersion!);
  const writer = new WorkStore(); writer.db.exec('BEGIN IMMEDIATE');
  try { expect((await request('a', body)).status).toBe(409); expect(store.records('a', 'integration-request')).toHaveLength(0); }
  finally { writer.db.exec('ROLLBACK'); writer.onApplicationShutdown(); }
  const initial = await request('a', body); expect(initial.status).toBe(200);
  const other = new WorkStore(); try { expect(other.records('a', 'integration-request')).toEqual(store.records('a', 'integration-request')); const service = new IntegrationService(other, settings); expect(() => service.reserve(service.parse(input(b, 'other-connection')), readiness)).toThrow(/활성 통합 후보/); expect(service.replay('a', service.parse(body))).toEqual(initial.data); } finally { other.onApplicationShutdown(); }
  await app.close(); app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl(); expect(await request('a', body)).toEqual(initial);
});
it('변조된 업무 소유권·copy 공간·현재 소스 변경을 통합하지 않는다', async () => {
  const identityPath = join(a.executionPath!, '..', 'identity.json'), identity = readFileSync(identityPath, 'utf8');
  writeFileSync(identityPath, identity.replace('"workId":"a"', '"workId":"foreign"')); expect((await request('a', body)).status).toBe(409); writeFileSync(identityPath, identity);
  const saved = structuredClone(a); a.workspace!.kind = 'copy'; store.save(a); expect((await request('a', body)).status).toBe(409); store.save(saved);
  writeFileSync(join(a.executionPath!, 'code.txt'), 'unverified'); expect((await request('a', body)).status).toBe(409); expect(store.records('a', 'integration-request')).toHaveLength(0);
});
it('후보 용량이 미확인이면 예약하지 않고 기존 멱등 응답은 그대로 조회한다', async () => {
  const view = settings.view.bind(settings), actual = view(); const spy = vi.spyOn(settings, 'view').mockReturnValue({ ...actual, freeBytes: null });
  expect((await request('a', body)).status).toBe(409); expect(store.records('a', 'integration-request')).toHaveLength(0); spy.mockRestore();
  const fresh = { ...body, requestKey: 'capacity-retry' }, initial = await request('a', fresh); expect(initial.status).toBe(200); vi.spyOn(settings, 'view').mockReturnValue({ ...view(), freeBytes: null }); expect(await request('a', fresh)).toEqual(initial);
});
it.skipIf(process.platform !== 'win32')('설치 Git이 지원하지 않는 긴 후보 경로는 DB 예약 전에 차단한다', async () => {
  const path = join(root, ...Array.from({ length: 5 }, (_, index) => `${index}-${'x'.repeat(70)}`)); select(path);
  const result = await request('a', body); expect(result.status).toBe(409); expect(result.data.errorCode).toBe('workspace-git-path-unsupported'); expect(store.records('a', 'integration-request')).toHaveLength(0); expect(store.get('a')?.executionPath).toBe(a.executionPath);
});
it('업무 index·공유 관리·대상 ref 점유와 영속 uncertain는 예약을 막고 독립 업무는 허용한다', async () => {
  const b = await fixture('b'), coordinator = projectCoordinator(store);
  for (const operation of [
    { kind: 'index' as const, root: a.executionPath! },
    { kind: 'management' as const, root: source },
    { kind: 'index' as const, root: source },
  ]) {
    const release = coordinator.acquireOperation(operation);
    try { expect((await request('a', { ...body, requestKey: 'locked-' + operation.kind + '-' + (operation.root === source ? 'source' : 'work') })).status).toBe(409); expect(store.records('a', 'integration-request')).toHaveLength(0); }
    finally { release(); }
  }
  store.record('uncertain-a', 'a', 'workspace-git-intent', { scope: 'index', root: a.executionPath, commonDir: a.workspace!.commonDir, affectedRoots: [a.executionPath], refs: [`refs/heads/${a.workspace!.branch}`], status: 'uncertain' });
  expect((await request('a', body)).status).toBe(409); expect(store.records('a', 'integration-request')).toHaveLength(0);
  const bBody = input(b, 'independent-b'), accepted = await request('b', bBody); expect(accepted.status).toBe(200);
  const release = coordinator.acquireOperation({ kind: 'management', root: source });
  try { expect(await request('b', bBody)).toEqual(accepted); } finally { release(); }
});
it('예약 pre-intent 거부만 exact key marker를 주고 같은 rejected key/different body를 구분한다', async () => {
  const stale = { ...body, requestKey: 'admission-stale', expectedWorkHead: '0'.repeat(40) }, before = store.get('a');
  const rejected = await request('a', stale); expect(rejected).toMatchObject({ status: 409, data: { mutationOutcome: 'rejected-before-intent', requestKey: stale.requestKey } });
  expect(await request('a', stale)).toMatchObject({ status: 409, data: { mutationOutcome: 'rejected-before-intent', requestKey: stale.requestKey } });
  const changed = await request('a', { ...stale, expectedWorkHead: body.expectedWorkHead }); expect(changed.status).toBe(409); expect(changed.data).not.toHaveProperty('mutationOutcome'); expect(store.get('a')).toEqual(before); expect(store.integrationRequests()).toEqual([]);
  const accepted = await request('a', { ...body, requestKey: 'fresh-admission' }); expect(accepted.status).toBe(200); expect(await request('a', { ...body, requestKey: 'fresh-admission' })).toEqual(accepted);
  const different = await request('a', { ...body, requestKey: 'fresh-admission', targetBranch: 'different' }); expect(different.status).toBe(409); expect(different.data).not.toHaveProperty('mutationOutcome');
});
it('동일 key HTTP preflight가 다른 handler에서 살아 있으면 marker를 내지 않는다', async () => {
  const actual = works.integrationReadiness.bind(works); let reached!: () => void, release!: () => void; const arrived = new Promise<void>(resolve => { reached = resolve; }); let calls = 0;
  vi.spyOn(works, 'integrationReadiness').mockImplementation(async (...args) => { if (++calls === 1) { reached(); await new Promise<void>(resolve => { release = resolve; }); } return actual(...args); });
  const stale = { ...body, requestKey: 'concurrent-preflight', expectedTargetHead: '0'.repeat(40) }, first = request('a', stale); await arrived;
  try { const second = await request('a', stale); expect(second.status).toBe(409); expect(second.data).not.toHaveProperty('mutationOutcome'); expect(store.integrationRequests()).toEqual([]); }
  finally { release(); }
  expect(await first).toMatchObject({ status: 409, data: { mutationOutcome: 'rejected-before-intent', requestKey: stale.requestKey } }); expect(store.integrationRequests()).toEqual([]);
});
