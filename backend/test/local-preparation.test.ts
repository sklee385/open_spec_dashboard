import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, linkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore, type Work } from '../src/work/store';
import { LocalPreparation, type LocalPreparationPolicy } from '../src/work/local-preparation';
let store: WorkStore, dir: string, source: string, target: string, work: Work, policy: LocalPreparationPolicy;
const file = (path: string, data: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, data); };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'l-')); source = join(dir, 's'); target = join(dir, 'w', 'project'); mkdirSync(source); mkdirSync(target, { recursive: true });
  process.env.DATA_DIR = join(dir, 'data'); process.env.CONFIG_PATH = join(dir, 'config.json'); writeFileSync(process.env.CONFIG_PATH, '{}'); store = new WorkStore();
  work = { id: 'a', sourceId: 'demo', projectPath: source, changeName: 'feature', requestKey: 'a', ideaIds: [], phase: 'reviewed', state: 'idle', threadId: 'same-thread', reviewedVersion: 'review', createdAt: '', updatedAt: '', executionPath: target, workspace: { version: 1, kind: 'git-worktree', status: 'preparing', rootId: 'root', profileId: 'profile', rootPath: dir, managedPath: dir, projectId: 'a'.repeat(64), workspaceId: 'space', executionPath: target, workspaceBaselineCommit: 'b'.repeat(40), sourcePlanRevision: 'plan' } }; store.save(work);
  policy = { version: 1, projectId: work.workspace!.projectId, planRevision: 'plan', confirmed: true, runtime: 'none', dependencies: 'none', paths: [], generatedPaths: [], commands: [] };
});
afterEach(() => { store.onApplicationShutdown(); delete process.env.DATA_DIR; delete process.env.CONFIG_PATH; delete process.env.DESKTOP_TOKEN; });
it('확인한 로컬 목록만 독립 복사하고 비밀값과 운영 자료를 응답에 넣지 않는다', async () => {
  file(join(source, '.env'), 'PRIVATE_TOKEN=not-in-response'); file(join(source, '.tools/node-runtime/version.txt'), 'runtime'); file(join(source, 'node_modules/example/index.js'), 'dependency'); file(join(source, '.data/production.sqlite'), 'production'); file(join(source, '.logs/live.log'), 'operation');
  policy.paths = ['.env', '.tools/node-runtime', 'node_modules']; policy.dependencies = 'copy';
  const result = await new LocalPreparation(store).prepare(work, policy);
  expect(result.status).toBe('ready'); expect(JSON.stringify(result)).not.toContain('not-in-response'); expect(JSON.stringify(store.records(work.id, 'workspace-local-preparation'))).not.toContain('not-in-response');
  expect(readFileSync(join(target, '.env'), 'utf8')).toBe('PRIVATE_TOKEN=not-in-response'); expect(existsSync(join(target, '.data'))).toBe(false); expect(existsSync(join(target, '.logs'))).toBe(false);
  writeFileSync(join(target, '.tools/node-runtime/version.txt'), 'changed'); writeFileSync(join(target, 'node_modules/example/index.js'), 'changed');
  expect(readFileSync(join(source, '.tools/node-runtime/version.txt'), 'utf8')).toBe('runtime'); expect(readFileSync(join(source, 'node_modules/example/index.js'), 'utf8')).toBe('dependency'); expect(work.threadId).toBe('same-thread');
});
it('미확인·다른 프로젝트·운영 데이터·탈출·링크 목록은 준비하지 않는다', async () => {
  const service = new LocalPreparation(store);
  await expect(service.prepare(work, { ...policy, confirmed: false })).rejects.toThrow(/확인/);
  await expect(service.prepare(work, { ...policy, projectId: 'other' })).rejects.toThrow(/프로젝트|정책/);
  await expect(service.prepare(work, { ...policy, paths: ['.data'] })).rejects.toThrow(/보호|목록/);
  await expect(service.prepare(work, { ...policy, paths: ['../outside'] })).rejects.toThrow(/경로|목록/);
  mkdirSync(join(source, 'node_modules')); symlinkSync(join(dir, 'data'), join(source, 'node_modules/shared'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(service.prepare(work, { ...policy, dependencies: 'copy', paths: ['node_modules'] })).rejects.toThrow(/링크|준비/);
  expect(existsSync(join(target, 'node_modules/shared'))).toBe(false);
});
it('독립 Node로 준비 명령을 업무 cwd·별도 데이터/캐시에서 실행하고 운영 토큰을 전달하지 않는다', async () => {
  const runtime = join(source, '.tools/node-runtime'); mkdirSync(runtime, { recursive: true }); copyFileSync(process.execPath, join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'));
  process.env.DESKTOP_TOKEN = 'operating-secret'; policy.runtime = 'node'; policy.paths = ['.tools/node-runtime']; policy.generatedPaths = ['built.txt']; policy.commands = [{ id: 'build', stage: 'build', command: 'node', args: ['-e', "require('fs').writeFileSync('built.txt', process.cwd()+'\\n'+process.env.DATA_DIR+'\\n'+String(process.env.DESKTOP_TOKEN))"] }];
  const service = new LocalPreparation(store); const result = await service.prepare(work, policy);
  expect(result.status).toBe('ready'); expect(readFileSync(join(target, 'built.txt'), 'utf8')).toBe(`${target}\n${join(target, '..', 'runtime-data')}\nundefined`);
  expect(existsSync(join(source, 'built.txt'))).toBe(false); await service.close();
});
it('설치/빌드 실패는 출력 비밀값 없이 기록하고 준비 완료·AI 실행을 차단한다', async () => {
  policy.commands = [{ id: 'build', stage: 'build', command: 'fixture', args: [] }];
  const service = new LocalPreparation(store, { run: async () => { file(join(target, 'partial.txt'), 'preserved'); throw new Error('PRIVATE_TOKEN=must-not-leak'); } });
  await expect(service.prepare(work, policy)).rejects.toThrow(/준비|명령/);
  expect(existsSync(join(target, 'partial.txt'))).toBe(true); expect(store.get(work.id)?.workspace?.status).toBe('failed');
  expect(JSON.stringify(store.records(work.id, 'workspace-local-preparation'))).not.toContain('must-not-leak'); expect(JSON.stringify(store.records(work.id, 'workspace-preparation'))).not.toContain('must-not-leak');
});
it('생성된 공유 hardlink는 준비 완료로 인정하지 않는다', async () => {
  file(join(source, 'original.txt'), 'source'); policy.generatedPaths = ['generated.txt']; policy.commands = [{ id: 'build', stage: 'build', command: 'fixture', args: [] }];
  const service = new LocalPreparation(store, { run: async () => { linkSync(join(source, 'original.txt'), join(target, 'generated.txt')); } });
  await expect(service.prepare(work, policy)).rejects.toThrow(/링크|준비/); expect(readFileSync(join(source, 'original.txt'), 'utf8')).toBe('source'); expect(store.get(work.id)?.workspace?.status).toBe('failed');
});
it('기존 데이터 junction을 채택하거나 외부 폴더에 식별 파일을 쓰지 않는다', async () => {
  const external = join(dir, 'external'); mkdirSync(external);
  symlinkSync(external, join(target, '..', 'runtime-data'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(new LocalPreparation(store).prepare(work, policy)).rejects.toThrow();
  expect(existsSync(join(external, 'identity.json'))).toBe(false);
  expect(store.get(work.id)?.workspace?.status).toBe('failed');
});
it('준비 자료 변조 후에는 명령을 자동 재실행하지 않는다', async () => {
  file(join(source, '.env'), 'TOKEN=original'); policy.paths = ['.env'];
  policy.commands = [{ id: 'build', stage: 'build', command: 'fixture', args: [] }];
  const run = vi.fn(async () => {}), service = new LocalPreparation(store, { run });
  await service.prepare(work, policy); await service.prepare(work, policy);
  expect(run).toHaveBeenCalledTimes(1);
  writeFileSync(join(target, '.env'), 'TOKEN=changed');
  await expect(service.prepare(work, policy)).rejects.toThrow(/변경|복구/);
  expect(run).toHaveBeenCalledTimes(1); expect(readFileSync(join(source, '.env'), 'utf8')).toBe('TOKEN=original');
});
it('명령이 사설 데이터에 외부 hardlink를 만들면 실패로 보존한다', async () => {
  file(join(source, 'private.txt'), 'keep');
  policy.commands = [{ id: 'build', stage: 'build', command: 'fixture', args: [] }];
  const service = new LocalPreparation(store, { run: async (_, context) => { linkSync(join(source, 'private.txt'), join(context.env.DATA_DIR!, 'shared.txt')); } });
  await expect(service.prepare(work, policy)).rejects.toThrow(/hardlink|준비/);
  expect(readFileSync(join(source, 'private.txt'), 'utf8')).toBe('keep');
  expect(existsSync(join(target, '..', 'runtime-data', 'shared.txt'))).toBe(true);
  expect(store.get(work.id)?.workspace?.status).toBe('failed');
});
it('정상 종료한 준비 명령의 자식 서버도 소유 가드에서 정리한다', async () => {
  const runtime = join(source, '.tools/node-runtime'); mkdirSync(runtime, { recursive: true }); copyFileSync(process.execPath, join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'));
  policy.runtime = 'node'; policy.paths = ['.tools/node-runtime']; policy.generatedPaths = ['child.pid'];
  const script = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{stdio:'ignore',detached:true});require('fs').writeFileSync('child.pid',String(c.pid));c.unref();";
  policy.commands = [{ id: 'build', stage: 'build', command: 'node', args: ['-e', script] }];
  const service = new LocalPreparation(store);
  try {
    await service.prepare(work, policy);
    const pid = Number(readFileSync(join(target, 'child.pid'), 'utf8'));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
    expect(store.records(work.id, 'workspace-local-process')[0].status).toBe('passed');
  } finally { await service.close(); }
}, 15000);
it('소유 가드가 없으면 프로젝트 명령을 시작하지 않는다', async () => {
  const previous = process.env.OPENSPEC_BROWSER_DIRECTORY;
  process.env.OPENSPEC_BROWSER_DIRECTORY = join(dir, 'missing-guard');
  policy.commands = [{ id: 'build', stage: 'build', command: process.execPath, args: ['-e', "require('fs').writeFileSync('must-not-run.txt','executed')"] }];
  const service = new LocalPreparation(store);
  try {
    await expect(service.prepare(work, policy)).rejects.toThrow(/준비|명령/);
    expect(existsSync(join(target, 'must-not-run.txt'))).toBe(false);
    expect(store.get(work.id)?.workspace?.status).toBe('failed');
    expect(store.records(work.id, 'workspace-local-process')[0].status).toBe('uncertain');
  } finally { await service.close(); if (previous === undefined) delete process.env.OPENSPEC_BROWSER_DIRECTORY; else process.env.OPENSPEC_BROWSER_DIRECTORY = previous; }
});
