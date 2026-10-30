import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { VerificationEnvironments } from '../src/browser/verification-environment';
import { LegacyService } from '../src/legacy/legacy.service';
import { ProjectResolver } from '../src/projects/resolver';
import { WorkStore, type Work, type IntegrationRequest } from '../src/work/store';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorktreeManager } from '../src/work/worktree-manager';
import { candidateIdentity } from '../src/work/integration-candidate';

vi.setConfig({ hookTimeout: 30000, testTimeout: 15000 });
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const saved = { DATA_DIR: process.env.DATA_DIR, CONFIG_PATH: process.env.CONFIG_PATH, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
let dir: string, source: string, store: WorkStore, legacy: LegacyService, environments: VerificationEnvironments, work: Work, copy: Work, candidate: IntegrationRequest;
const scenario = { name: 'registered', server: { command: 'node', args: ['server.cjs'], url: 'http://127.0.0.1:19121' }, steps: [{ op: 'expectURL', path: '/' }] };
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'e-')); source = join(dir, 's'); mkdirSync(source); mkdirSync(join(dir, 'config'));
  for (const name of ['a', 'c']) {
    const docs = join(source, 'openspec/changes', name); mkdirSync(join(docs, 'specs/demo'), { recursive: true });
    for (const file of ['proposal.md', 'design.md', 'tasks.md', 'specs/demo/spec.md']) writeFileSync(join(docs, file), '# plan\n');
  }
  writeFileSync(join(source, 'code.txt'), 'source'); git(source, 'init', '-b', 'main'); git(source, 'config', 'core.autocrlf', 'false'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test'); git(source, 'add', '--all'); git(source, 'commit', '-m', 'base');
  process.env.DATA_DIR = join(dir, 'data'); process.env.CONFIG_PATH = join(dir, 'config/config.json'); delete process.env.WORKSPACE_ROOT;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(source, 'openspec') }] }));
  store = new WorkStore(); legacy = new LegacyService(); const settings = new WorkspaceSettingsService(legacy, store), config = settings.read(), check = settings.check({ version: config.version, path: join(dir, 'r') }); settings.save({ version: config.version, token: check.token, confirmed: true });
  work = { id: 'a', sourceId: 'demo', projectPath: source, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'verification', state: 'idle', threadId: 'thread-a', reviewedVersion: 'review', browserScenario: scenario, createdAt: '', updatedAt: '' }; store.save(work);
  const head = git(source, 'rev-parse', 'HEAD'); await new WorktreeManager({ store }).create(work, settings, { requestKey: 'create', selectedBranch: 'main', baseCommit: head, sourceHead: head }); work.workspace!.status = 'ready'; work.workspace!.workspaceBaselineCommit = head; store.save(work);
  const space = work.workspace!, candidateId = randomUUID(), container = join(space.managedPath, 'projects', space.projectId, 'integrations', candidateId); mkdirSync(container, { recursive: true });
  const path = join(container, 'project'); git(source, 'worktree', 'add', '-b', `codex/integration-${candidateId}`, '--', path, 'main');
  candidate = { ...space, version: 1, id: 'candidate-a', candidateId, workId: work.id, requestKey: 'candidate', fingerprint: 'fixture', executionPath: path, workExecutionPath: work.executionPath!, commonDir: space.commonDir!, projectPath: source, workspaceId: space.workspaceId, candidateCommit: head, candidateMutationVersion: 'epoch-one', targetBranch: 'main', targetHead: head, workHead: head, resultCommit: head, reviewedVersion: 'review', sourceRevision: 'fixture', workVerificationRefs: [], verificationRefs: [], conflicts: [], status: 'validating', createdAt: '', updatedAt: '' };
  writeFileSync(join(container, 'identity.json'), JSON.stringify(candidateIdentity(candidate))); store.record(candidate.id, work.id, 'integration-request', candidate);
  const copyRoot = join(dir, 'copy/project'); mkdirSync(join(copyRoot, 'openspec/changes/c/specs/demo'), { recursive: true });
  for (const file of ['proposal.md', 'design.md', 'tasks.md', 'specs/demo/spec.md']) writeFileSync(join(copyRoot, 'openspec/changes/c', file), '# copy plan\n');
  copy = { ...work, id: 'c', requestKey: 'c', changeName: 'c', executionPath: copyRoot, workspace: undefined }; store.save(copy); store.record('copy-baseline', copy.id, 'isolated-baseline', { executionPath: copyRoot }); writeFileSync(join(dirname(copyRoot), 'identity.json'), JSON.stringify({ workId: copy.id, projectPath: source }));
  environments = new VerificationEnvironments(store, new ProjectResolver(legacy, store));
});
afterAll(async () => { await legacy?.onModuleDestroy(); store?.onApplicationShutdown(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

it('실제 업무·후보 경계와 미준비 build를 별개로 고정하고 디렉터리를 생성하지 않는다', async () => {
  const first = await environments.capture({ sourceId: 'demo', workId: 'a' }), second = await environments.capture({ sourceId: 'demo', workId: 'a', candidateId: candidate.candidateId });
  expect(first.environment).toMatchObject({ targetKind: 'work', workId: 'a', candidateId: null, workspaceKind: 'git-worktree', executionPath: work.executionPath, commit: candidate.candidateCommit, origin: scenario.server.url, ownership: 'verified', build: { state: 'unprepared', buildId: null }, readiness: 'blocked' });
  expect(second.environment).toMatchObject({ targetKind: 'integration-candidate', candidateId: candidate.candidateId, candidateEpoch: 'epoch-one', executionPath: candidate.executionPath, commit: candidate.candidateCommit });
  expect(first.environment.environmentId).not.toBe(second.environment.environmentId); expect(first.environment.dataPath).not.toBe(second.environment.dataPath); expect(first.environment.evidencePath).not.toBe(second.environment.evidencePath);
  expect(existsSync(first.environment.dataPath)).toBe(false); expect(existsSync(first.environment.evidencePath)).toBe(false); expect(first.environment.sourceRevision).toMatch(/^[a-f0-9]{64}$/); expect(first.environment.planRevision).toMatch(/^[a-f0-9]{64}$/); expect(first.environment.configVersion).toMatch(/^[a-f0-9]{64}$/);
  await first.assertCurrent(); await second.assertCurrent();
});
it('기존 비Git 사본은 copy와 nullable commit으로 소유 확인한다', async () => {
  const proof = await environments.capture({ sourceId: 'demo', workId: copy.id }); expect(proof.environment).toMatchObject({ workspaceKind: 'copy', commit: null, workspaceId: null, executionPath: copy.executionPath, ownership: 'verified', readiness: 'blocked' }); await proof.assertCurrent();
});
it('임의 경로·명령·build 지정과 타 source/work/candidate 조합은 대체 경로 없이 거부한다', async () => {
  for (const extra of [{ path: source }, { target: 'other' }, { command: 'git' }, { buildId: 'fake' }]) await expect(environments.capture({ sourceId: 'demo', workId: 'a', ...extra })).rejects.toThrow();
  await expect(environments.capture({ sourceId: 'other', workId: 'a' })).rejects.toThrow(); await expect(environments.capture({ sourceId: 'demo', workId: 'missing' })).rejects.toThrow(); await expect(environments.capture({ sourceId: 'demo', workId: copy.id, candidateId: candidate.candidateId })).rejects.toThrow();
});
it('원본 출처 변경과 현재 후보 세대·HEAD 변경을 매번 다시 거부한다', async () => {
  const proof = await environments.capture({ sourceId: 'demo', workId: 'a', candidateId: candidate.candidateId });
  store.record(candidate.id, work.id, 'integration-request', { ...candidate, candidateMutationVersion: 'epoch-two' }); await expect(proof.assertCurrent()).rejects.toThrow(); store.record(candidate.id, work.id, 'integration-request', candidate);
  git(candidate.executionPath, 'checkout', '--detach'); await expect(proof.assertCurrent()).rejects.toThrow(); git(candidate.executionPath, 'checkout', `codex/integration-${candidate.candidateId}`);
  store.save({ ...work, projectPath: copy.executionPath! }); await expect(proof.assertCurrent()).rejects.toThrow(); store.save(work);
});
it('source·plan·설정·등록 시나리오 변화는 기존 환경을 무효화한다', async () => {
  const proof = await environments.capture({ sourceId: 'demo', workId: 'a' }), code = join(work.executionPath!, 'code.txt'), before = readFileSync(code);
  writeFileSync(code, 'changed'); await expect(proof.assertCurrent()).rejects.toThrow(); writeFileSync(code, before);
  const plan = join(work.executionPath!, 'openspec/changes/a/design.md'), oldPlan = readFileSync(plan); writeFileSync(plan, '# new plan'); await expect(proof.assertCurrent()).rejects.toThrow(); writeFileSync(plan, oldPlan);
  store.save({ ...work, sourceMutationVersion: 'next' }); await expect(proof.assertCurrent()).rejects.toThrow(); store.save(work);
  store.save({ ...work, browserScenario: { ...scenario, server: { ...scenario.server, url: 'http://127.0.0.1:19122' } } }); await expect(proof.assertCurrent()).rejects.toThrow(); store.save(work);
});
it('등록 origin만 사용하고 예약 포트·호스트 데이터와 소스 중첩은 차단한다', async () => {
  store.save({ ...work, browserScenario: { ...scenario, server: { ...scenario.server, url: 'http://127.0.0.1:13003' } } }); await expect(environments.capture({ sourceId: 'demo', workId: 'a' })).rejects.toThrow(); store.save(work);
  const data = process.env.DATA_DIR; process.env.DATA_DIR = join(work.executionPath!, 'browser-data'); try { await expect(environments.capture({ sourceId: 'demo', workId: 'a' })).rejects.toThrow(); } finally { process.env.DATA_DIR = data; }
});
