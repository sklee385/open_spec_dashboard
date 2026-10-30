import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkStore, type Work, type IntegrationRequest } from '../src/work/store';
import { LegacyService } from '../src/legacy/legacy.service';
import { ProjectResolver } from '../src/projects/resolver';
import { BrowserService } from '../src/browser/browser.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorktreeManager } from '../src/work/worktree-manager';
import { collectWorkspaceDocuments } from '../src/work/workspace-documents';
import { candidateIdentity } from '../src/work/integration-candidate';
vi.setConfig({ hookTimeout: 30000, testTimeout: 180000 });
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const saved = { CONFIG_PATH: process.env.CONFIG_PATH, DATA_DIR: process.env.DATA_DIR, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
let store: WorkStore, legacy: LegacyService, browser: BrowserService, work: Work, candidate: IntegrationRequest;
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bld-')), source = join(dir, 's'); mkdirSync(join(source, 'openspec/changes/a/specs/demo'), { recursive: true }); mkdirSync(join(dir, 'c'));
  for (const file of ['proposal.md', 'design.md', 'tasks.md', 'specs/demo/spec.md']) writeFileSync(join(source, 'openspec/changes/a', file), '# plan\n');
  writeFileSync(join(source, 'input.txt'), 'fresh compiled bytes');
  writeFileSync(join(source, 'build.cjs'), "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/app.js','console.log('+JSON.stringify(fs.readFileSync('input.txt','utf8'))+')');\n");
  writeFileSync(join(source, 'openspec/browser-build.json'), JSON.stringify({ version: 1, build: { command: 'node', args: ['build.cjs'] }, artifacts: [{ path: 'dist/app.js', urlPath: '/app.js' }], identity: { path: 'dist/identity.json', urlPath: '/identity.json' } }));
  writeFileSync(join(source, 'server.cjs'), "const fs=require('fs');require('http').createServer((q,r)=>{if(q.url==='/app.js'||q.url==='/identity.json'){r.end(fs.readFileSync('dist'+q.url));return;}if(q.url==='/change')fs.writeFileSync('dist/app.js','changed while running');r.end('<h1>Fresh build</h1><script src=\"/app.js\"></script>');}).listen(Number(process.env.PORT),'127.0.0.1');\n");
  git(source, 'init', '-b', 'main'); git(source, 'config', 'core.autocrlf', 'false'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test'); git(source, 'add', '--all'); git(source, 'commit', '-m', 'source');
  process.env.CONFIG_PATH = join(dir, 'c/config.json'); process.env.DATA_DIR = join(dir, 'data'); delete process.env.WORKSPACE_ROOT;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(source, 'openspec') }] })); store = new WorkStore(); legacy = new LegacyService();
  const settings = new WorkspaceSettingsService(legacy, store), config = settings.read(), check = settings.check({ version: config.version, path: join(dir, 'r') }); settings.save({ version: config.version, token: check.token, confirmed: true });
  const port = createServer(); await new Promise<void>(resolve => port.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(port.address() as any).port}`; await new Promise<void>(resolve => port.close(() => resolve()));
  work = { id: 'a', sourceId: 'demo', projectPath: source, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'verification', state: 'idle', threadId: 'original-thread', reviewedVersion: 'review', browserScenario: { name: 'fresh', server: { command: 'node', args: ['server.cjs'], url: origin }, steps: [{ op: 'goto', path: '/' }, { op: 'expectVisible', target: { role: 'heading', name: 'Fresh build' } }] }, createdAt: '', updatedAt: '' }; store.save(work);
  const head = git(source, 'rev-parse', 'HEAD'); await new WorktreeManager({ store }).create(work, settings, { requestKey: 'create', selectedBranch: 'main', baseCommit: head, sourceHead: head }); work.workspace!.status = 'ready'; work.workspace!.workspaceBaselineCommit = head; work.workspace!.sourcePlanRevision = collectWorkspaceDocuments(source, 'a').planRevision; store.save(work);
  const space = work.workspace!, id = randomUUID(), container = join(space.managedPath, 'projects', space.projectId, 'integrations', id); mkdirSync(container, { recursive: true }); const path = join(container, 'project'); git(source, 'worktree', 'add', '-b', `codex/integration-${id}`, '--', path, 'main');
  candidate = { ...space, version: 1, id: 'candidate-a', candidateId: id, workId: work.id, requestKey: 'candidate', fingerprint: 'fixture', executionPath: path, workExecutionPath: work.executionPath!, commonDir: space.commonDir!, projectPath: source, workspaceId: space.workspaceId, candidateCommit: head, candidateMutationVersion: 'epoch', targetBranch: 'main', targetHead: head, workHead: head, resultCommit: head, reviewedVersion: 'review', sourceRevision: 'fixture', workVerificationRefs: [], verificationRefs: [], conflicts: [], status: 'validating', createdAt: '', updatedAt: '' }; writeFileSync(join(container, 'identity.json'), JSON.stringify(candidateIdentity(candidate))); store.record(candidate.id, work.id, 'integration-request', candidate);
  browser = new BrowserService(store, new ProjectResolver(legacy, store));
});
afterEach(async () => { await browser?.onModuleDestroy(); await legacy?.onModuleDestroy(); store?.onApplicationShutdown(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
async function run(candidateId?: string) { const result = browser.run(work.id, 'user', candidateId); await vi.waitFor(() => expect(browser.activity(work.id).running).toBe(false), { timeout: 120000 }); return store.records(work.id, 'browser-verification').find(row => row.id === result.id)!; }
it('실제 업무·후보는 각각 새 사본·서버·data·증거와 새 빌드 attestation으로 통과한다', async () => {
  const first = await run(), second = await run(candidate.candidateId);
  expect({ status: first.status, error: first.error }).toEqual({ status: 'passed', error: undefined }); expect({ status: second.status, error: second.error }).toEqual({ status: 'passed', error: undefined });
  expect(first.targetKind).toBe('work'); expect(second).toMatchObject({ targetKind: 'integration-candidate', candidateId: candidate.candidateId }); expect(first.environmentId).not.toBe(second.environmentId); expect(first.environment.dataPath).not.toBe(second.environment.dataPath); expect(first.buildAttestation.buildId).not.toBe(second.buildAttestation.buildId);
  expect(first.environment.build.state).toBe('unprepared'); expect(second.buildAttestation.sourceRevision).toBe(second.environment.sourceRevision); expect(existsSync(first.evidencePath)).toBe(true); expect(existsSync(second.evidencePath)).toBe(true);
  for (const root of [work.projectPath, work.executionPath!, candidate.executionPath]) expect(existsSync(join(root, 'dist'))).toBe(false); expect(store.get(work.id)?.threadId).toBe('original-thread');
});
it('새 빌드 실패는 브라우저 입력 전 blocked이고 원본·업무 소스를 보존한다', async () => {
  writeFileSync(join(work.executionPath!, 'build.cjs'), 'process.exit(7)'); const before = readFileSync(join(work.executionPath!, 'input.txt'), 'utf8'), row = await run(); expect(row.status).toBe('blocked'); expect(row.steps).toEqual([]); expect(row.error).toContain('빌드'); expect(row.buildAttestation).toBeUndefined(); expect(readFileSync(join(work.executionPath!, 'input.txt'), 'utf8')).toBe(before);
});
it('시나리오 중 서버가 artifact를 바꾸면 passed 직전 실제bytes 재검사에서 blocked다', async () => {
  work.browserScenario = { ...(work.browserScenario as any), steps: [{ op: 'goto', path: '/change' }, { op: 'expectVisible', target: { role: 'heading', name: 'Fresh build' } }] }; store.save(work);
  const row = await run(); expect(row.status).toBe('blocked'); expect(row.steps).toHaveLength(2); expect(row.error).toContain('산출물'); expect(existsSync(join(work.executionPath!, 'dist'))).toBe(false);
});
