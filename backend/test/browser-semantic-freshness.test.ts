import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkStore, type Work, type IntegrationRequest } from '../src/work/store';
import { LegacyService } from '../src/legacy/legacy.service';
import { ProjectResolver } from '../src/projects/resolver';
import { BrowserService } from '../src/browser/browser.service';
import { BrowserFreshness } from '../src/browser/browser-freshness';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorktreeManager } from '../src/work/worktree-manager';
import { collectWorkspaceDocuments } from '../src/work/workspace-documents';
import { candidateIdentity } from '../src/work/integration-candidate';
import { IntegrationVerification } from '../src/work/integration-verification';
import { DesktopLifecycle } from '../src/desktop/lifecycle';
import { browserBuildFixture } from './fixtures/browser-build-fixture';
vi.setConfig({ hookTimeout: 60000, testTimeout: 60000 });
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const saved = { CONFIG_PATH: process.env.CONFIG_PATH, DATA_DIR: process.env.DATA_DIR, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
let store: WorkStore, legacy: LegacyService, browser: BrowserService, work: Work, candidate: IntegrationRequest, settings: WorkspaceSettingsService, resolver: ProjectResolver, workPass: any, candidatePass: any;
async function run(candidateId?: string) { const result = browser.run(work.id, 'user', candidateId); await vi.waitFor(() => expect(browser.activity(work.id, candidateId).running).toBe(false), { timeout: 50000 }); const row = store.records(work.id, 'browser-verification').find(row => row.id === result.id)!; expect({ status: row.status, error: row.error }).toEqual({ status: 'passed', error: undefined }); return row; }
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bsem-')), source = join(dir, 's'); mkdirSync(source); mkdirSync(join(dir, 'c')); browserBuildFixture(source, 'a'); writeFileSync(join(source, 'openspec/changes/a/tasks.md'), '# plan\n- [ ] planned task\n'); copyFileSync(resolve('test/fixtures/browser-server.cjs'), join(source, 'server.cjs'));
  git(source, 'init', '-b', 'main'); git(source, 'config', 'core.autocrlf', 'false'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test'); git(source, 'add', '--all'); git(source, 'commit', '-m', 'source');
  process.env.CONFIG_PATH = join(dir, 'c/config.json'); process.env.DATA_DIR = join(dir, 'data'); delete process.env.WORKSPACE_ROOT; writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(source, 'openspec') }] })); store = new WorkStore(); legacy = new LegacyService(); settings = new WorkspaceSettingsService(legacy, store); const config = settings.read(), check = settings.check({ version: config.version, path: join(dir, 'r') }); settings.save({ version: config.version, token: check.token, confirmed: true });
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(probe.address() as any).port}`; await new Promise<void>(resolve => probe.close(() => resolve()));
  work = { id: 'a', sourceId: 'demo', projectPath: source, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'verification', state: 'idle', threadId: 'thread', reviewedVersion: 'review', verificationCommands: [{ id: 'cli', command: process.execPath, args: ['-e', 'process.exit(0)'] }], browserScenario: { name: 'fresh', server: { command: 'node', args: ['server.cjs'], url: origin }, steps: [{ op: 'goto', path: '/' }, { op: 'expectVisible', target: { role: 'heading', name: '검증' } }] }, createdAt: '', updatedAt: '' }; store.save(work);
  const head = git(source, 'rev-parse', 'HEAD'); await new WorktreeManager({ store }).create(work, settings, { requestKey: 'create', selectedBranch: 'main', baseCommit: head, sourceHead: head }); work.workspace!.status = 'ready'; work.workspace!.workspaceBaselineCommit = head; work.workspace!.sourcePlanRevision = collectWorkspaceDocuments(source, 'a').planRevision; store.save(work);
  const space = work.workspace!, id = randomUUID(), container = join(space.managedPath, 'projects', space.projectId, 'integrations', id); mkdirSync(container, { recursive: true }); const path = join(container, 'project'); git(source, 'worktree', 'add', '-b', `codex/integration-${id}`, '--', path, 'main'); candidate = { ...space, version: 1, id: 'candidate-a', candidateId: id, workId: work.id, requestKey: 'candidate', fingerprint: 'fixture', executionPath: path, workExecutionPath: work.executionPath!, commonDir: space.commonDir!, projectPath: source, workspaceId: space.workspaceId, candidateCommit: head, candidateMutationVersion: 'epoch', targetBranch: 'main', targetHead: head, workHead: head, resultCommit: head, reviewedVersion: 'review', sourceRevision: 'fixture', workVerificationRefs: [], verificationRefs: [], conflicts: [], status: 'validating', createdAt: '', updatedAt: '' }; writeFileSync(join(container, 'identity.json'), JSON.stringify(candidateIdentity(candidate))); store.record(candidate.id, work.id, 'integration-request', candidate);
  resolver = new ProjectResolver(legacy, store); browser = new BrowserService(store, resolver); workPass = await run(); candidatePass = await run(candidate.candidateId);
});
afterAll(async () => { vi.restoreAllMocks(); await browser?.onModuleDestroy(); await legacy?.onModuleDestroy(); store?.onApplicationShutdown(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

it('Work 결과 commit만 바뀌고 실제 입력이 같으면 실행commit 역사를 보존하며 명시 fresh다', async () => {
  const history = JSON.stringify(workPass); git(work.executionPath!, 'commit', '--allow-empty', '-m', 'result metadata only');
  const status = await browser.status(work.id, true); expect(status.observation.state).toBe('fresh'); expect(status.results.at(-1)?.id).toBe(workPass.id); await expect(browser.assertPassed(store.get(work.id)!)).resolves.toBeUndefined(); expect(JSON.stringify(store.records(work.id, 'browser-verification').find(row => row.id === workPass.id))).toBe(history); expect(workPass.freshnessEvidence.executedCommit).not.toBe(git(work.executionPath!, 'rev-parse', 'HEAD'));
  expect((await browser.status(work.id)).results.some(row => row.candidateId)).toBe(false); expect((await browser.status(work.id, true, candidate.candidateId)).results.at(-1)?.fresh).toBe(true);
});
it('기본 정책은 checkbox만 바뀌어도 stale이며 raw 통과 역사를 수정하지 않는다', async () => {
  const path = join(work.executionPath!, 'openspec/changes/a/tasks.md'), before = readFileSync(path); writeFileSync(path, before.toString().replace('[ ]', '[x]'));
  try { expect((await browser.status(work.id, true)).observation.state).toBe('stale'); await expect(browser.assertPassed(store.get(work.id)!)).rejects.toThrow(); expect(store.records(work.id, 'browser-verification').find(row => row.id === workPass.id)?.status).toBe('passed'); } finally { writeFileSync(path, before); }
});
it('후보 epoch와 실제 원본 target ref 변화는 Work 통과로 대체하지 않고 거부한다', async () => {
  store.record(candidate.id, work.id, 'integration-request', { ...candidate, candidateMutationVersion: 'next' }); try { expect((await browser.status(work.id, true, candidate.candidateId)).observation.state).toBe('stale'); } finally { store.record(candidate.id, work.id, 'integration-request', candidate); }
  git(work.projectPath, 'commit', '--allow-empty', '-m', 'target changed'); const changed = git(work.projectPath, 'rev-parse', 'HEAD'); try { await expect(browser.capturePassedProof(work.id, candidate.candidateId)).rejects.toThrow(/ref/); } finally { git(work.projectPath, 'update-ref', 'refs/heads/main', candidate.targetHead, changed); }
});
function verification(checkPublication: () => boolean = () => true) {
  // 6.1 owns actual CLI execution. This suite supplies its exact latest receipt to
  // exercise only the new combination with real browser/target evidence.
  const works: any = { get: (id: string) => store.get(id), browser };
  const service = new IntegrationVerification(store, works, resolver, settings, new DesktopLifecycle(store), {} as any);
  vi.spyOn(service as any, 'capture').mockImplementation(async () => ({ work: store.get(work.id), request: store.integrationRequests().find(row => row.id === candidate.id), version: 'cli-basis', checkPublication }));
  store.record('cli-pass', work.id, 'candidate-verification', { candidateId: candidate.candidateId, status: 'passed', candidateVersion: 'cli-basis', processTerminated: true }); return service;
}
it('IV는 최신 CLI와 같은 후보 전용 browser proof 둘 다 있어야 ready와 apply refs를 만든다', async () => {
  const service = verification(); store.db.prepare('DELETE FROM records WHERE id=?').run(candidatePass.id);
  try { expect((await service.results(work.id, candidate.candidateId)).ready).toBe(false); await expect(service.captureReadyProof(work.id, candidate.candidateId)).rejects.toThrow(); } finally { store.record(candidatePass.id, work.id, 'browser-verification', candidatePass); }
  expect((await service.results(work.id, candidate.candidateId)).ready).toBe(true); expect((await service.captureReadyProof(work.id, candidate.candidateId)).verificationRefs).toEqual(['cli-pass', candidatePass.id]);
  store.record('cli-new-failed', work.id, 'candidate-verification', { candidateId: candidate.candidateId, status: 'failed', candidateVersion: 'cli-basis', processTerminated: true }); try { expect((await service.results(work.id, candidate.candidateId)).ready).toBe(false); } finally { store.db.prepare('DELETE FROM records WHERE id=?').run('cli-new-failed'); store.record(candidate.id, work.id, 'integration-request', candidate); }
});
it.each(['epoch', 'browser-row'])('늦은 ready 조회는 새 %s 관측을 덮지 않는다', async mode => {
  const service = verification(), capture = browser.capturePassedProof.bind(browser); let changed = false;
  const spy = vi.spyOn(browser, 'capturePassedProof').mockImplementation(async (...args: any[]) => { const proof = await capture(...args); if (!changed) { changed = true; if (mode === 'epoch') store.record(candidate.id, work.id, 'integration-request', { ...candidate, candidateMutationVersion: 'newest', status: 'validating' }); else store.record('new-browser-row', work.id, 'browser-verification', { candidateId: candidate.candidateId, targetKind: 'integration-candidate', status: 'blocked', requestKey: 'new-request' }); } return proof; });
  try { const result = await service.results(work.id, candidate.candidateId); expect(changed).toBe(true); expect(result.ready).toBe(false); expect(store.integrationRequests().find(row => row.id === candidate.id)).toMatchObject({ status: 'validating', candidateMutationVersion: mode === 'epoch' ? 'newest' : 'epoch' }); } finally { spy.mockRestore(); store.record(candidate.id, work.id, 'integration-request', candidate); store.db.prepare('DELETE FROM records WHERE id=?').run('new-browser-row'); }
});
it('명시 독립성은 checkbox·정확한 attested 생성물만 허용하고 본문·AGENTS·코드·설정·deps는 stale다', async () => {
  const contractPath = join(work.executionPath!, 'openspec/browser-build.json'), contract = JSON.parse(readFileSync(contractPath, 'utf8')); contract.freshness = { tasksCheckboxes: 'independent-plan-metadata-v1' }; writeFileSync(contractPath, JSON.stringify(contract)); const passed = await run(), history = JSON.stringify(passed);
  const tasks = join(work.executionPath!, 'openspec/changes/a/tasks.md'), initial = readFileSync(tasks, 'utf8'); writeFileSync(tasks, initial.replace('[ ]', '[x]')); expect((await browser.status(work.id, true)).observation.state).toBe('fresh');
  mkdirSync(join(work.executionPath!, 'dist'), { recursive: true }); writeFileSync(join(work.executionPath!, 'dist/fixture-app.js'), 'different generated bytes'); writeFileSync(join(work.executionPath!, 'dist/fixture-identity.json'), 'generated local identity'); expect((await browser.status(work.id, true)).observation.state).toBe('fresh');
  for (const path of ['AGENTS.md', 'input-code.ts', 'dist/AGENTS.md', 'node_modules/dependency.js']) { const full = join(work.executionPath!, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, 'new input'); try { expect((await browser.status(work.id, true)).observation.state, path).toBe('stale'); } finally { unlinkSync(full); if (path.startsWith('node_modules/')) rmdirSync(dirname(full)); } expect((await browser.status(work.id, true)).observation.state, path+' removed').toBe('fresh'); }
  writeFileSync(tasks, initial.replace('planned task', 'changed actual plan')); expect((await browser.status(work.id, true)).observation.state).toBe('stale'); writeFileSync(tasks, initial.replace('[ ]', '[x]'));
  const current = store.get(work.id)!; store.save({ ...current, verificationCommands: [{ id: 'changed', command: process.execPath, args: ['-e', 'process.exit(1)'] }] }); try { expect((await browser.status(work.id, true)).observation.state).toBe('stale'); } finally { store.save(current); }
  expect(JSON.stringify(store.records(work.id, 'browser-verification').find(row => row.id === passed.id))).toBe(history);
});
