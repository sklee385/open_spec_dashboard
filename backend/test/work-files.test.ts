import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Subject } from 'rxjs';
import { Work, WorkStore } from '../src/work/store';
import { ExecutionService } from '../src/work/execution.service';
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), renameSync: vi.fn(actual.renameSync), cpSync: vi.fn(actual.cpSync) };
});

let root: string, source: string, store: WorkStore, execution: ExecutionService, work: Work;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-files-')); source = join(root, 'source'); mkdirSync(source);
  process.env.DATA_DIR = join(root, 'data'); process.env.WORKSPACE_ROOT = join(root, 'spaces');
  store = new WorkStore(); execution = new ExecutionService(store, { updates: new Subject() } as any);
  work = { id: 'a', sourceId: 'demo', projectPath: source, changeName: 'feature', requestKey: 'a', ideaIds: [], phase: 'reviewed', state: 'idle', threadId: null, reviewedVersion: 'plan', createdAt: '', updatedAt: '' }; store.save(work);
  writeFileSync(join(source, 'existing.txt'), 'uncommitted');
});
afterEach(() => { vi.restoreAllMocks(); execution.onModuleDestroy(); store.onApplicationShutdown(); delete process.env.DATA_DIR; delete process.env.WORKSPACE_ROOT; });
const prepare = () => (execution as any).prepare(work);
const report = () => (execution as any).changeReport(work);

it('격리 기준이 없는 기존 업무는 공유 폴더 차이를 반환하지 않는다', () => {
  store.record('old', work.id, 'baseline', { files: {} });
  expect(execution.changes(work)).toEqual([]);
  expect(report().source).toBe('unavailable');
});
it('기존 공유 폴더 업무는 명시적 전환 이후부터 변경을 수집한다', () => {
  store.record('old', work.id, 'baseline', { files: {} });
  expect(() => execution.prepare(work)).toThrow(/명시적 전환/);
  execution.prepare(work, true); expect(execution.changes(work)).toEqual([]);
  writeFileSync(join(execution.executionPath(work), 'existing.txt'), 'after transition');
  expect(execution.changes(work)).toMatchObject([{ before: 'uncommitted', after: 'after transition' }]);
});
it('Git 없이 독립 복사하고 두 업무와 원본의 동일 파일 변경을 분리한다', async () => {
  await prepare(); const path = (execution as any).executionPath(work);
  const other = { ...work, id: 'b', changeName: 'other', requestKey: 'b', executionPath: undefined }; store.save(other); await (execution as any).prepare(other);
  writeFileSync(join(source, 'existing.txt'), 'source edit');
  writeFileSync(join((execution as any).executionPath(other), 'existing.txt'), 'B');
  writeFileSync(join(path, 'existing.txt'), 'A');
  expect(execution.changes(work)).toMatchObject([{ path: 'existing.txt', before: 'uncommitted', after: 'A', status: 'modified' }]);
  expect(execution.changes(other)[0].after).toBe('B');
  expect(readFileSync(join(source, 'existing.txt'), 'utf8')).toBe('source edit');
});
it('빈 파일과 바이너리·크기 제한을 구분하고 체크박스만 변경되면 제외한다', async () => {
  mkdirSync(join(source, 'openspec'), { recursive: true }); writeFileSync(join(source, 'openspec', 'tasks.md'), '- [ ] done');
  await prepare(); const path = (execution as any).executionPath(work);
  writeFileSync(join(path, 'empty'), ''); writeFileSync(join(path, 'binary'), Buffer.from([0, 1])); writeFileSync(join(path, 'large'), Buffer.alloc(200000, 65));
  writeFileSync(join(path, 'openspec', 'tasks.md'), '- [x] done');
  const files = execution.changes(work);
  expect(files.map(f => f.path)).toEqual(['binary', 'empty', 'large']);
  expect(files).toMatchObject([{ afterAvailability: 'binary' }, { after: '', afterAvailability: 'text' }, { afterAvailability: 'size-limit' }]);
});
it('원본 충돌 시 덮어쓰지 않고 다른 업무 파일은 보존한다', async () => {
  await prepare(); const path = (execution as any).executionPath(work); writeFileSync(join(path, 'existing.txt'), 'A');
  writeFileSync(join(source, 'existing.txt'), 'B');
  expect(() => (execution as any).apply(work)).toThrow(/충돌/);
  expect(readFileSync(join(source, 'existing.txt'), 'utf8')).toBe('B');
  writeFileSync(join(source, 'existing.txt'), 'uncommitted'); writeFileSync(join(source, 'other.txt'), 'B');
  (execution as any).apply(work);
  expect(readFileSync(join(source, 'existing.txt'), 'utf8')).toBe('A'); expect(readFileSync(join(source, 'other.txt'), 'utf8')).toBe('B');
});
it('완료 저장 실패는 상태를 되돌리고 완료 결과는 재시작·폴더 삭제·보관 후에도 유지한다', async () => {
  await prepare(); writeFileSync(join((execution as any).executionPath(work), 'existing.txt'), 'A');
  expect(() => (execution as any).freeze(work)).toThrow(/반영/);
  (execution as any).apply(work); (execution as any).freeze(work);
  const expected = report(); expect(store.get(work.id)?.phase).toBe('completed');
  rmSync(source, { recursive: true }); rmSync((work as any).executionPath, { recursive: true });
  execution.onModuleDestroy(); execution = new ExecutionService(store, { updates: new Subject() } as any);
  work.phase = 'archived'; expect(report()).toEqual(expected);
});
it('없어진 업무 공간이나 잘못된 식별자를 원본으로 대체하지 않는다', async () => {
  await prepare(); rmSync((work as any).executionPath, { recursive: true });
  expect(() => (execution as any).executionPath(work)).toThrow(/복구/);
});
it('프로젝트 런타임과 의존성은 원본과 파일을 공유하지 않는 복사본이다', async () => {
  mkdirSync(join(source, '.tools', 'node-runtime'), { recursive: true }); mkdirSync(join(source, 'node_modules', 'example'), { recursive: true });
  writeFileSync(join(source, '.tools', 'node-runtime', 'runtime.txt'), 'runtime'); writeFileSync(join(source, 'node_modules', 'example', 'index.js'), 'module');
  await prepare(); const path = execution.executionPath(work);
  writeFileSync(join(path, '.tools', 'node-runtime', 'runtime.txt'), 'changed'); writeFileSync(join(path, 'node_modules', 'example', 'index.js'), 'changed');
  expect(readFileSync(join(source, '.tools', 'node-runtime', 'runtime.txt'), 'utf8')).toBe('runtime');
  expect(readFileSync(join(source, 'node_modules', 'example', 'index.js'), 'utf8')).toBe('module');
  expect(execution.changes(work)).toEqual([]);
});
it('복사 실패는 기준을 저장하지 않으며 재시도는 새 독립 공간에서 시작한다', () => {
  vi.mocked(fs.cpSync).mockImplementationOnce(() => { throw new Error('copy failure'); });
  expect(() => execution.prepare(work)).toThrow('copy failure'); expect(store.records(work.id, 'isolated-baseline')).toEqual([]);
  expect(work.executionPath).toBeUndefined(); execution.prepare(work); expect(execution.changes(work)).toEqual([]);
});
it('파일 읽기 실패를 빈 변경으로 확정하지 않는다', async () => {
  await prepare(); const path = join(execution.executionPath(work), 'existing.txt'), read = (await vi.importActual<typeof import('node:fs')>('node:fs')).readFileSync;
  vi.mocked(fs.readFileSync).mockImplementation(((file: any, ...args: any[]) => { if (String(file) === path) throw new Error('read failure'); return (read as any)(file, ...args); }) as any);
  expect(() => execution.snapshot(work)).toThrow('read failure'); expect(report()).toMatchObject({ source: 'unavailable', error: 'read failure' });
});
it('남은 반영 임시 파일은 저널로 소유권을 확인하고 재사용한다', async () => {
  await prepare(); writeFileSync(join(execution.executionPath(work), 'existing.txt'), 'A');
  const rename = vi.mocked(fs.renameSync); rename.mockImplementationOnce(() => { throw new Error('interruption'); });
  expect(() => execution.apply(work)).toThrow('interruption');
  const application = store.records(work.id, 'application')[0], entry = application.entries[0];
  writeFileSync(entry.tempPath, Buffer.from(entry.after, 'base64'));
  execution.apply(work); expect(readFileSync(join(source, 'existing.txt'), 'utf8')).toBe('A');
});
it('동일 업무의 반영 후 추가 수정은 재검증·재반영할 수 있다', async () => {
  await prepare(); const path = execution.executionPath(work);
  writeFileSync(join(path, 'existing.txt'), 'A'); execution.apply(work);
  writeFileSync(join(path, 'existing.txt'), 'A2'); expect(report().application).toBe('not-applied'); execution.apply(work);
  expect(readFileSync(join(source, 'existing.txt'), 'utf8')).toBe('A2');
});
it('이미 반영한 수정을 기준 상태로 되돌리면 원본도 되돌아가야 완료할 수 있다', async () => {
  await prepare(); const path = execution.executionPath(work);
  writeFileSync(join(path, 'existing.txt'), 'A'); execution.apply(work);
  writeFileSync(join(path, 'existing.txt'), 'uncommitted');
  execution.apply(work); execution.freeze(work);
  expect(readFileSync(join(source, 'existing.txt'), 'utf8')).toBe('uncommitted'); expect(report().files).toEqual([]);
});
it('원본 반영 뒤 체크박스만 바뀌어도 재반영 전에는 완료할 수 없다', async () => {
  mkdirSync(join(source, 'openspec', 'changes', work.changeName), { recursive: true });
  writeFileSync(join(source, 'openspec', 'changes', work.changeName, 'tasks.md'), '- [ ] done');
  await prepare(); execution.apply(work);
  writeFileSync(join(execution.executionPath(work), 'openspec', 'changes', work.changeName, 'tasks.md'), '- [x] done');
  expect(() => execution.freeze(work)).toThrow(/반영/);
  execution.apply(work); execution.freeze(work);
  expect(readFileSync(join(source, 'openspec', 'changes', work.changeName, 'tasks.md'), 'utf8')).toBe('- [x] done');
});
it('완료 상태 저장 실패는 결과 기록까지 롤백하며 재시도한다', async () => {
  await prepare(); writeFileSync(join(execution.executionPath(work), 'existing.txt'), 'A'); execution.apply(work);
  const save = vi.spyOn(store, 'save').mockImplementationOnce(() => { throw new Error('disk failure'); });
  expect(() => execution.freeze(work)).toThrow('disk failure');
  expect(store.records(work.id, 'completed-changes')).toEqual([]); expect(store.get(work.id)!.phase).toBe('reviewed'); expect(work.phase).toBe('reviewed');
  save.mockRestore(); execution.freeze(work); expect(store.get(work.id)!.phase).toBe('completed');
});
it('부분 반영 실패 뒤 재시작하여 저널로 나머지 경로를 안전하게 반영한다', async () => {
  await prepare(); const path = execution.executionPath(work);
  writeFileSync(join(path, 'existing.txt'), 'A'); writeFileSync(join(path, 'z.txt'), 'Z');
  const rename = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (String(to).endsWith('z.txt')) throw new Error('write failure'); return rename(from, to); });
  expect(() => execution.apply(work)).toThrow('write failure'); expect(report().application).toBe('applying'); spy.mockRestore();
  execution.onModuleDestroy(); execution = new ExecutionService(store, { updates: new Subject() } as any);
  execution.apply(work); expect(readFileSync(join(source, 'z.txt'), 'utf8')).toBe('Z'); expect(report().application).toBe('applied');
});
it('수집 도중 파일이 바뀌면 결과를 확정하지 않는다', async () => {
  await prepare(); const path = join(execution.executionPath(work), 'existing.txt'), read = (await vi.importActual<typeof import('node:fs')>('node:fs')).readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => { const result = (read as any)(file, ...args); if (String(file) === path) writeFileSync(path, 'changed during read'); return result; }) as any);
  expect(() => execution.snapshot(work)).toThrow(/수집 중 변경/);
});
