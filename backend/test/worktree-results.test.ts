import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { WorkStore, type Work } from '../src/work/store';
import { LegacyService } from '../src/legacy/legacy.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorkspaceProvisioner } from '../src/work/workspace-provisioner';
import { FileResults } from '../src/work/file-results';
import { ExecutionService } from '../src/work/execution.service';
import { ProjectResolver } from '../src/projects/resolver';
import * as gitRunner from '../src/projects/git-runner';
import { ProjectFiles } from '../src/projects/files';
import { ProjectGit } from '../src/projects/git';
import { workspaceSourcePolicy } from '../src/work/workspace-file-policy';
vi.setConfig({ hookTimeout: 60000, testTimeout: 30000 });
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let dir: string, source: string, store: WorkStore, legacy: LegacyService, settings: WorkspaceSettingsService, provisioner: WorkspaceProvisioner, a: Work, b: Work;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'r-')); source = join(dir, 's'); mkdirSync(source); mkdirSync(join(dir, 'config'));
  for (const change of ['alpha', 'beta']) { const path = join(source, 'openspec/changes', change); mkdirSync(join(path, 'specs/test'), { recursive: true }); for (const file of ['proposal.md', 'design.md', 'tasks.md', 'specs/test/spec.md']) writeFileSync(join(path, file), '# baseline\n'); }
  writeFileSync(join(source, 'code.txt'), 'base'); git(source, 'init', '-b', 'main'); git(source, 'config', 'core.autocrlf', 'false'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test'); git(source, 'add', '--', 'code.txt', 'openspec'); git(source, 'commit', '-m', 'base');
  process.env.CONFIG_PATH = join(dir, 'config/config.json'); process.env.DATA_DIR = join(dir, 'data'); delete process.env.WORKSPACE_ROOT;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(source, 'openspec') }] })); legacy = new LegacyService(); store = new WorkStore(); settings = new WorkspaceSettingsService(legacy, store);
  const config = settings.read(), check = settings.check({ version: config.version, path: join(dir, 'r') }); settings.save({ version: config.version, token: check.token, confirmed: true });
  provisioner = new WorkspaceProvisioner(store, settings, { enabled: () => true });
  const prepare = async (id: string, changeName: string) => {
    const work: Work = { id, sourceId: 'demo', projectPath: source, changeName, requestKey: id, ideaIds: [], phase: 'reviewed', state: 'idle', threadId: `thread-${id}`, reviewedVersion: 'review', createdAt: '', updatedAt: '' }; store.save(work);
    writeFileSync(join(source, `openspec/changes/${changeName}/proposal.md`), '# reviewed change\n');
    const preview = await provisioner.preview(work, 'main'); await provisioner.prepare(work, { requestKey: `create-${id}`, previewToken: preview.documents!.confirmationToken, excludedConfirmed: true, policy: { version: 1, projectId: preview.projectId, planRevision: preview.documents!.planRevision, confirmed: true, runtime: 'none', dependencies: 'none', paths: [], generatedPaths: [], commands: [] } }); return store.get(id)!;
  };
  a = await prepare('a', 'alpha'); b = await prepare('b', 'beta');
});
afterAll(async () => { await provisioner?.close(); await legacy?.onModuleDestroy(); store?.onApplicationShutdown(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; delete process.env.WORKSPACE_ROOT; });
it('문서 기준 이후 A/B diff는 원본 미커밋·다른 공간·로컬 비밀값과 분리한다', () => {
  writeFileSync(join(source, 'code.txt'), 'original edit'); writeFileSync(join(a.executionPath!, 'code.txt'), 'A'); writeFileSync(join(b.executionPath!, 'code.txt'), 'B'); writeFileSync(join(a.executionPath!, '.env'), 'TOKEN=never-in-report');
  const files = new FileResults(store), first = files.report(a), second = files.report(b);
  expect(first.source).toBe('current'); expect(first.files).toMatchObject([{ path: 'code.txt', before: 'base', after: 'A' }]);
  expect(second.files).toMatchObject([{ path: 'code.txt', before: 'base', after: 'B' }]); expect(JSON.stringify(first)).not.toContain('never-in-report');
  expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('original edit'); expect(a.threadId).toBe('thread-a');
});
it('루트 변경 후 resolver와 명령 cwd는 기존 A/B 공간에 고정되고 실행 결과를 섞지 않는다', async () => {
  process.env.WORKSPACE_ROOT = join(dir, 'changed-root');
  const resolver = new ProjectResolver(legacy, store); expect(resolver.resolve('demo', a.id).root).toBe(a.executionPath); expect(resolver.resolve('demo', b.id).root).toBe(b.executionPath);
  const execution = new ExecutionService(store, legacy);
  a.verificationCommands = [{ id: 'cwd', command: process.execPath, args: ['-e', 'console.log(process.cwd())'] }]; store.save(a);
  try { execution.run(a, 'cwd'); await vi.waitFor(() => expect(store.records(a.id, 'verification')[0]?.status).toBe('passed'), { timeout: 5000 }); expect(store.records(a.id, 'verification')[0].stdout.trim()).toBe(a.executionPath); expect(store.records(b.id, 'verification')).toHaveLength(0); }
  finally { execution.onModuleDestroy(); }
});
it('내용이 같은 executable mode 변경도 표시하고 기존 검증을 무효화한다', async () => {
  a = store.get(a.id)!; a.verificationCommands = [{ id: 'mode-check', command: process.execPath, args: ['-e', 'console.log("checked")'] }]; store.save(a);
  const execution = new ExecutionService(store, legacy);
  try {
    execution.run(a, 'mode-check'); await vi.waitFor(() => expect(store.records(a.id, 'verification').at(-1)?.status).toBe('passed'), { timeout: 5000 });
    expect(execution.results(a).at(-1)?.fresh).toBe(true);
    git(a.executionPath!, 'update-index', '--chmod=+x', '--', 'code.txt');
    expect(execution.results(a).at(-1)?.fresh).toBe(false);
    expect(new FileResults(store).report(a).files.find((file: any) => file.path === 'code.txt')).toMatchObject({ beforeMode: '100644', afterMode: '100755' });
  } finally { execution.onModuleDestroy(); }
});
it('수집 중 내용이 같고 MM 상태가 유지돼도 mode가 달라지면 미확인으로 차단한다', () => {
  git(a.executionPath!, 'update-index', '--chmod=+x', '--', 'code.txt');
  git(a.executionPath!, 'add', '--', 'code.txt'); writeFileSync(join(a.executionPath!, 'code.txt'), 'unstaged after stage');
  expect(git(a.executionPath!, 'status', '--porcelain')).toContain('MM code.txt');
  const original = gitRunner.readGitSync; let snapshots = 0;
  const spy = vi.spyOn(gitRunner, 'readGitSync').mockImplementation((root, args) => {
    const result = original(root, args);
    if (root === a.executionPath && args[0] === 'ls-files' && args.includes('--stage') && ++snapshots === 2) git(root, 'update-index', '--chmod=-x', '--', 'code.txt');
    return result;
  });
  try { expect(new FileResults(store).report(a)).toMatchObject({ source: 'unavailable', error: expect.stringContaining('수집 중') }); }
  finally { spy.mockRestore(); }
});
it('로컬 준비 목록은 소스 본문·Git diff/status 응답에서도 제외한다', async () => {
  a = store.get(a.id)!; a.workspace!.localOnlyPaths = ['test.settings.json']; store.save(a);
  writeFileSync(join(a.executionPath!, '.env'), 'TOKEN=fixture-private'); writeFileSync(join(a.executionPath!, 'test.settings.json'), 'fixture-local-settings');
  const policy = workspaceSourcePolicy(store), files = new ProjectFiles(policy), projectGit = new ProjectGit({ dataDir: join(dir, 'query-data'), sourcePolicy: policy });
  try {
    await expect(files.read(a.executionPath!, '.env')).rejects.toThrow(/excluded/);
    await expect(files.read(a.executionPath!, 'test.settings.json')).rejects.toThrow(/excluded/);
    await expect(projectGit.diff(a.executionPath!, { path: '.env', side: 'unstaged' })).rejects.toThrow(/excluded/);
    const status = await projectGit.status(a.executionPath!); expect(status.entries.some(entry => entry.path === '.env' || entry.path === 'test.settings.json')).toBe(false);
    expect(JSON.stringify(status)).not.toContain('fixture-private'); expect(JSON.stringify(new FileResults(store).snapshot(a))).not.toContain('fixture-local-settings');
    linkSync(join(a.executionPath!, '.env'), join(a.executionPath!, 'safe.txt'));
    await expect(files.read(a.executionPath!, 'safe.txt')).rejects.toThrow(/링크|소유/);
    await expect(projectGit.diff(a.executionPath!, { path: 'safe.txt', side: 'unstaged' })).rejects.toThrow(/링크|소유/);
    expect(new FileResults(store).report(a).source).toBe('unavailable');
  } finally { await projectGit.close(); }
});
it('준비 뒤 생긴 gitlink도 정상 파일 변경 없음으로 숨기지 않는다', () => {
  mkdirSync(join(b.executionPath!, 'module')); git(b.executionPath!, 'update-index', '--add', '--cacheinfo', '160000', b.workspace!.baseCommit!, 'module');
  expect(new FileResults(store).report(b)).toMatchObject({ source: 'unavailable', error: expect.stringMatching(/Git|경계|형식/) });
});
it('기존 공간을 잃으면 resolver와 실행이 원본을 대신 사용하지 않는다', () => {
  renameSync(b.executionPath!, `${b.executionPath}-preserved`);
  expect(() => new ProjectResolver(legacy, store).resolve('demo', b.id)).toThrow(/복구/);
  expect(() => new ExecutionService(store, legacy).executionPath(b)).toThrow(/복구/);
});
