import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { WorktreeManager } from '../src/work/worktree-manager';
import { WorkStore, type Work } from '../src/work/store';
import { LegacyService } from '../src/legacy/legacy.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { collectWorkspaceDocuments } from '../src/work/workspace-documents';
import { runGit } from '../src/projects/git-runner';
import { LocalPreparation } from '../src/work/local-preparation';
vi.setConfig({ testTimeout: 30000 });
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let dir: string, source: string, change: string, legacy: LegacyService, store: WorkStore, settings: WorkspaceSettingsService, work: Work, request: any, manager: WorktreeManager;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-')); source = join(dir, 's'); change = join(source, 'openspec', 'changes', 'feature'); mkdirSync(join(change, 'specs', 'feature'), { recursive: true });
  git(source, 'init', '-b', 'main'); git(source, 'config', 'core.autocrlf', 'false'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(join(source, 'code.txt'), 'base');
  for (const name of ['proposal.md', 'design.md', 'tasks.md', 'specs/feature/spec.md']) writeFileSync(join(change, name), '# baseline\n');
  git(source, 'add', '--', 'code.txt', 'openspec/changes/feature'); git(source, 'commit', '-m', 'base');
  process.env.CONFIG_PATH = join(dir, 'config.json'); process.env.DATA_DIR = join(dir, 'data'); delete process.env.WORKSPACE_ROOT;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [] })); legacy = new LegacyService(); store = new WorkStore(); settings = new WorkspaceSettingsService(legacy, store);
  vi.spyOn(settings, 'protectedPaths').mockReturnValue([source, process.env.DATA_DIR]);
  const initial = settings.read(), check = settings.check({ version: initial.version, path: join(dir, 'r') }); settings.save({ version: initial.version, token: check.token, confirmed: true });
  work = { id: 'a', sourceId: 'demo', projectPath: source, changeName: 'feature', requestKey: 'a', ideaIds: [], phase: 'reviewed', state: 'idle', threadId: 'same-thread', reviewedVersion: 'reviewed-plan', createdAt: '', updatedAt: '' }; store.save(work);
  const head = git(source, 'rev-parse', 'HEAD'); request = { requestKey: 'create-a', selectedBranch: 'main', baseCommit: head, sourceHead: head }; manager = new WorktreeManager({ store });
});
afterEach(async () => { await legacy.onModuleDestroy(); store.onApplicationShutdown(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; });
it('제외 목록 확인 뒤 해당 문서만 가져오며 미커밋 제품·다른 업무·비밀값과 원본 index는 유지한다', async () => {
  writeFileSync(join(source, 'code.txt'), 'dirty product'); writeFileSync(join(source, '.env'), 'SECRET=not-imported'); writeFileSync(join(change, 'proposal.md'), '# reviewed new proposal\n');
  mkdirSync(join(change, 'source-ideas')); writeFileSync(join(change, 'source-ideas', 'idea.md'), '# idea'); mkdirSync(join(source, 'openspec', 'changes', 'other'), { recursive: true }); writeFileSync(join(source, 'openspec', 'changes', 'other', 'proposal.md'), '# other');
  const preview = await manager.previewDocuments(work, 'main'), before = git(source, 'status', '--porcelain=v1');
  expect(preview.excluded.map(entry => entry.path)).toEqual(expect.arrayContaining(['code.txt', '.env', 'openspec/changes/other/proposal.md']));
  await manager.create(work, settings, request);
  await expect(manager.importDocuments(work, settings, { ...preview, excludedConfirmed: false })).rejects.toThrow(/확인/);
  expect(readFileSync(join(work.executionPath!, 'openspec/changes/feature/proposal.md'), 'utf8')).toBe('# baseline\n');
  const copied = await manager.importDocuments(work, settings, { ...preview, excludedConfirmed: true }); expect(copied.status).toBe('copied');
  expect(readFileSync(join(work.executionPath!, 'code.txt'), 'utf8')).toBe('base'); expect(existsSync(join(work.executionPath!, '.env'))).toBe(false); expect(existsSync(join(work.executionPath!, 'openspec/changes/other'))).toBe(false);
  expect(collectWorkspaceDocuments(work.executionPath!, 'feature').revision).toBe(preview.documentRevision); expect(git(source, 'status', '--porcelain=v1')).toBe(before); expect(git(source, 'rev-parse', 'HEAD')).toBe(request.sourceHead);
});
it('검토 후 문서나 제외 목록이 달라지면 복사와 AI 준비 완료를 차단한다', async () => {
  const preview = await manager.previewDocuments(work, 'main'); await manager.create(work, settings, request);
  writeFileSync(join(change, 'proposal.md'), '# changed after review');
  await expect(manager.importDocuments(work, settings, { ...preview, excludedConfirmed: true })).rejects.toThrow(/변경|검토/);
  expect(readFileSync(join(work.executionPath!, 'openspec/changes/feature/proposal.md'), 'utf8')).toBe('# baseline\n'); expect(store.get(work.id)?.workspace?.status).not.toBe('ready');
});
it('복사 중 원본 HEAD 변경은 부분 문서를 보존하며 완료로 저장하지 않는다', async () => {
  const preview = await manager.previewDocuments(work, 'main'); await manager.create(work, settings, request);
  let copyStarted = false;
  const changing = new WorktreeManager({ store, run: async (root, args) => {
    const result = await runGit(root, args);
    if (root === work.executionPath && args[0] === 'status') copyStarted = true;
    if (copyStarted && root === source && args[0] === 'rev-parse' && args[1] === '--is-bare-repository') { copyStarted = false; git(source, 'commit', '--allow-empty', '-m', 'source moved'); }
    return result;
  } });
  await expect(changing.importDocuments(work, settings, { ...preview, excludedConfirmed: true })).rejects.toThrow(/기준/);
  expect(existsSync(work.executionPath!)).toBe(true); expect(store.get(work.id)?.workspace?.status).toBe('recovery-required'); expect(store.records(work.id, 'workspace-documents').at(-1)?.status).not.toBe('copied');
});
it('문서 복사 도중 원문 변경은 원문과 부분 결과를 보존하고 재검토를 요구한다', async () => {
  writeFileSync(join(change, 'proposal.md'), '# reviewed proposal');
  const preview = await manager.previewDocuments(work, 'main'); await manager.create(work, settings, request);
  let copyStarted = false;
  const changing = new WorktreeManager({ store, run: async (root, args) => {
    const result = await runGit(root, args);
    if (root === work.executionPath && args[0] === 'status') copyStarted = true;
    if (copyStarted && root === source && args[0] === 'rev-parse' && args[1] === '--is-bare-repository') { copyStarted = false; writeFileSync(join(change, 'proposal.md'), '# revised during copy'); }
    return result;
  } });
  await expect(changing.importDocuments(work, settings, { ...preview, excludedConfirmed: true })).rejects.toThrow(/문서/);
  expect(readFileSync(join(work.executionPath!, 'openspec/changes/feature/proposal.md'), 'utf8')).toBe('# reviewed proposal');
  expect(readFileSync(join(change, 'proposal.md'), 'utf8')).toBe('# revised during copy');
  expect(store.get(work.id)?.workspace?.status).toBe('recovery-required');
});
it('제외 목록이 추가되거나 확인 토큰이 만료되면 문서 복사를 시작하지 않는다', async () => {
  const preview = await manager.previewDocuments(work, 'main'); await manager.create(work, settings, request);
  writeFileSync(join(source, 'new-untracked.txt'), 'new product');
  await expect(manager.importDocuments(work, settings, { ...preview, excludedConfirmed: true })).rejects.toThrow(/목록/);
  const fresh = await manager.previewDocuments(work, 'main');
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600000);
  try { await expect(manager.importDocuments(work, settings, { ...fresh, excludedConfirmed: true })).rejects.toThrow(/확인/); }
  finally { now.mockRestore(); }
  expect(store.records(work.id, 'workspace-documents')).toHaveLength(0);
});
it('다른 기준 브랜치에서 확인한 토큰을 실제 생성 기준에 재사용하지 않는다', async () => {
  git(source, 'branch', 'feature'); const preview = await manager.previewDocuments(work, 'feature');
  await manager.create(work, settings, request);
  await expect(manager.importDocuments(work, settings, { ...preview, excludedConfirmed: true })).rejects.toThrow(/기준/);
  expect(store.records(work.id, 'workspace-documents')).toHaveLength(0);
});

async function copiedPlan() {
  const preview = await manager.previewDocuments(work, 'main'); await manager.create(work, settings, request);
  await manager.importDocuments(work, settings, { ...preview, excludedConfirmed: true }); return preview;
}
it('문서만 업무 브랜치에 커밋하고 제품 기준·통합 기준·검토 revision을 보존한다', async () => {
  writeFileSync(join(change, 'proposal.md'), '# reviewed proposal'); writeFileSync(join(change, 'tasks.md'), '- [ ] implement\n'); writeFileSync(join(source, 'code.txt'), 'dirty product');
  const preview = await copiedPlan(), sourceStatus = git(source, 'status', '--porcelain=v1');
  // Git for Windows can stat a revision:path as a filename during `show`
  // disambiguation. Keep real Git/owned mutations; reproduce only that read error.
  const text = (manager as any).text.bind(manager);
  vi.spyOn(manager as any, 'text').mockImplementation(async (...input: any[]) => {
    const [root, args] = input;
    if (args[0] === 'show' && /^[a-f0-9]{40}:/.test(args[1])) throw new Error(`fatal: failed to stat '${args[1]}': Filename too long`);
    return text(root, args);
  });
  const baseline = await manager.commitDocuments(work, settings);
  expect(baseline.status).toBe('committed'); expect(work.workspace?.workspaceBaselineCommit).toBe(baseline.commit);
  const changed = git(work.executionPath!, 'diff', '--name-only', request.baseCommit, baseline.commit).split('\n').filter(Boolean);
  expect(changed.length).toBeGreaterThan(0); expect(changed.every(path => path.startsWith('openspec/changes/feature/'))).toBe(true);
  expect(git(work.executionPath!, 'diff', '--name-only', baseline.commit)).toBe('');
  expect(git(source, 'rev-parse', 'HEAD')).toBe(request.sourceHead); expect(git(source, 'status', '--porcelain=v1')).toBe(sourceStatus);
  writeFileSync(join(work.executionPath!, 'openspec/changes/feature/tasks.md'), '- [x] implement\n');
  expect(collectWorkspaceDocuments(work.executionPath!, 'feature').planRevision).toBe(preview.planRevision);
  writeFileSync(join(work.executionPath!, 'openspec/changes/feature/tasks.md'), '- [x] changed plan\n');
  expect(collectWorkspaceDocuments(work.executionPath!, 'feature').planRevision).not.toBe(preview.planRevision);
});
it('문서 기준 커밋에 미선택 제품 파일을 stage하거나 커밋하지 않는다', async () => {
  await copiedPlan(); writeFileSync(join(work.executionPath!, 'code.txt'), 'unreviewed product');
  await expect(manager.commitDocuments(work, settings)).rejects.toThrow(/문서|제품/);
  expect(git(work.executionPath!, 'rev-parse', 'HEAD')).toBe(request.baseCommit); expect(git(work.executionPath!, 'diff', '--cached', '--name-only')).toBe('');
});
it('문서 기준 커밋 성공 후 응답 유실을 실제 커밋으로 복구해 중복 커밋하지 않는다', async () => {
  writeFileSync(join(change, 'proposal.md'), '# reviewed proposal'); await copiedPlan(); let lost = false;
  const losing = new WorktreeManager({ store, run: async (root, args) => { const result = await runGit(root, args); if (!lost && args.includes('commit')) { lost = true; throw new Error('baseline response lost'); } return result; } });
  await expect(losing.commitDocuments(work, settings)).rejects.toThrow(/response lost/);
  const head = git(work.executionPath!, 'rev-parse', 'HEAD'); expect(head).not.toBe(request.baseCommit);
  const recovered = await manager.commitDocuments(store.get(work.id)!, settings); expect(recovered.status).toBe('committed'); expect(recovered.commit).toBe(head);
  expect(git(work.executionPath!, 'rev-list', '--count', `${request.baseCommit}..HEAD`)).toBe('1'); expect(store.get(work.id)?.threadId).toBe('same-thread');
});
it('커밋 응답 유실 뒤 제품/index가 바뀌면 복구 성공으로 확정하지 않는다', async () => {
  writeFileSync(join(change, 'proposal.md'), '# reviewed proposal'); await copiedPlan(); let lost = false;
  const losing = new WorktreeManager({ store, run: async (root, args) => { const result = await runGit(root, args); if (!lost && args.includes('commit')) { lost = true; throw new Error('baseline response lost'); } return result; } });
  await expect(losing.commitDocuments(work, settings)).rejects.toThrow(/response lost/);
  writeFileSync(join(work.executionPath!, 'code.txt'), 'changed while disconnected'); git(work.executionPath!, 'add', '--', 'code.txt');
  const head = git(work.executionPath!, 'rev-parse', 'HEAD'), staged = git(work.executionPath!, 'diff', '--cached');
  await expect(manager.commitDocuments(store.get(work.id)!, settings)).rejects.toThrow(/복구/);
  expect(git(work.executionPath!, 'rev-parse', 'HEAD')).toBe(head); expect(git(work.executionPath!, 'diff', '--cached')).toBe(staged);
  expect(store.get(work.id)?.workspace?.status).toBe('recovery-required');
});
it('실제 커밋 트리에 제거 대상 문서가 남으면 작업트리 상태가 깨끗해도 기준 확정을 막는다', async () => {
  const path = 'openspec/changes/feature/specs/old/spec.md'; mkdirSync(join(change, 'specs', 'old')); writeFileSync(join(source, path), '# old'); git(source, 'add', '--', path); git(source, 'commit', '-m', 'old spec');
  const base = git(source, 'rev-parse', 'HEAD'), blob = git(source, 'rev-parse', `HEAD:${path}`); request.baseCommit = base; request.sourceHead = base; unlinkSync(join(source, path)); writeFileSync(join(change, 'proposal.md'), '# new reviewed proposal');
  await copiedPlan();
  const changed = new WorktreeManager({ store, run: async (root, args) => {
    if (args.includes('commit')) { git(root, 'update-index', '--add', '--cacheinfo', '100644', blob, path); git(root, 'update-index', '--skip-worktree', '--', path); }
    return runGit(root, args);
  } });
  await expect(changed.commitDocuments(work, settings)).rejects.toThrow(/문서|계획|기준/);
  expect(store.get(work.id)?.workspace?.status).toBe('recovery-required'); expect(store.records(work.id, 'workspace-baseline')[0].status).not.toBe('committed');
});
it('문서 기준 뒤 확인한 로컬 준비만 연결하고 비밀값은 커밋·응답에 넣지 않는다', async () => {
  writeFileSync(join(source, '.env'), 'PRIVATE_TOKEN=do-not-commit'); await copiedPlan(); await manager.commitDocuments(work, settings);
  const policy = { version: 1, projectId: work.workspace!.projectId, planRevision: work.workspace!.sourcePlanRevision!, confirmed: true, runtime: 'none' as const, dependencies: 'none' as const, paths: ['.env'], generatedPaths: [], commands: [] };
  const result = await manager.prepareLocal(work, settings, policy);
  expect(result.status).toBe('ready'); expect(JSON.stringify(result)).not.toContain('do-not-commit');
  expect(readFileSync(join(work.executionPath!, '.env'), 'utf8')).toBe('PRIVATE_TOKEN=do-not-commit'); expect(git(work.executionPath!, 'ls-files', '--', '.env')).toBe(''); expect(git(work.executionPath!, 'rev-parse', 'HEAD')).toBe(work.workspace!.workspaceBaselineCommit);
  expect(work.workspace!.localOnlyPaths).toContain('.env'); expect(work.workspace!.status).toBe('preparing'); await manager.close();
});
it('로컬 준비 목록으로 미커밋 제품 코드를 우회 수입하지 않는다', async () => {
  writeFileSync(join(source, 'code.txt'), 'dirty product'); await copiedPlan(); await manager.commitDocuments(work, settings);
  await expect(manager.prepareLocal(work, settings, { version: 1, projectId: work.workspace!.projectId, planRevision: work.workspace!.sourcePlanRevision!, confirmed: true, runtime: 'none', dependencies: 'none', paths: ['code.txt'], generatedPaths: [], commands: [] })).rejects.toThrow(/제품/);
  expect(readFileSync(join(work.executionPath!, 'code.txt'), 'utf8')).toBe('base'); expect(store.records(work.id, 'workspace-local-preparation')).toHaveLength(0);
});
it('준비 명령이 기준 제품을 바꾸면 실패로 남기고 AI 준비 완료를 차단한다', async () => {
  await copiedPlan(); await manager.commitDocuments(work, settings);
  const local = new LocalPreparation(store, { run: async (_command, context) => { writeFileSync(join(context.cwd, 'code.txt'), 'unexpected product'); } });
  const checked = new WorktreeManager({ store, local });
  await expect(checked.prepareLocal(work, settings, { version: 1, projectId: work.workspace!.projectId, planRevision: work.workspace!.sourcePlanRevision!, confirmed: true, runtime: 'none', dependencies: 'none', paths: [], generatedPaths: [], commands: [{ id: 'build', stage: 'build', command: 'fixture', args: [] }] })).rejects.toThrow(/제품|준비/);
  expect(store.get(work.id)?.workspace?.status).toBe('failed'); expect(readFileSync(join(work.executionPath!, 'code.txt'), 'utf8')).toBe('unexpected product');
});

it('산출물 목록으로 추적 중인 src 제품 경로를 숨길 수 없다', async () => {
  mkdirSync(join(source, 'src')); writeFileSync(join(source, 'src/main.ts'), 'export const product = true;');
  git(source, 'add', '--', 'src'); git(source, 'commit', '-m', 'tracked source fixture');
  const head = git(source, 'rev-parse', 'HEAD'); request = { ...request, baseCommit: head, sourceHead: head };
  await copiedPlan(); await manager.commitDocuments(work, settings);
  await expect(manager.prepareLocal(work, settings, { version: 1, projectId: work.workspace!.projectId, planRevision: work.workspace!.sourcePlanRevision!, confirmed: true, runtime: 'none', dependencies: 'none', paths: [], generatedPaths: ['src'], commands: [] })).rejects.toThrow(/제품|추적/);
  expect(work.workspace!.localOnlyPaths || []).not.toContain('src');
  expect(store.records(work.id, 'workspace-local-preparation')).toHaveLength(0);
  expect(readFileSync(join(work.executionPath!, 'src/main.ts'), 'utf8')).toBe('export const product = true;');
});
