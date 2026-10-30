import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore } from '../src/work/store';
import { FileResults } from '../src/work/file-results';
import { BrowserMailbox } from '../src/browser/browser-mailbox';
import { browserBuildFixture, browserFixtureConfig } from './fixtures/browser-build-fixture';
import { backgroundToolResponse } from '../src/browser/browser-tools';

let store: WorkStore;
const mailboxes: BrowserMailbox[] = [], savedConfig = process.env.CONFIG_PATH, savedData = process.env.DATA_DIR;
const enumeration = vi.hoisted(() => ({ path: '', files: [] as string[] }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: (...args: any[]) => enumeration.path === String(args[0]) ? enumeration.files : (actual.readdirSync as any)(...args) };
});
afterEach(() => { enumeration.path = ''; enumeration.files = []; for (const mailbox of mailboxes.splice(0)) mailbox.close(); store?.onApplicationShutdown(); if (savedData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = savedData; if (savedConfig === undefined) delete process.env.CONFIG_PATH; else process.env.CONFIG_PATH = savedConfig; });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'browser-mailbox-regression-'));
  mkdirSync(join(root, 'openspec'));
  browserBuildFixture(root, 'test'); browserFixtureConfig(root, 'test');
  process.env.DATA_DIR = join(root, '.data'); store = new WorkStore();
  const work = store.save({ id: 'work', requestKey: 'work', sourceId: 'test', projectPath: root, changeName: 'test', ideaIds: [], phase: 'implementation', state: 'idle', threadId: 'existing-thread', reviewedVersion: null, createdAt: '', updatedAt: '', browserScenario: { name: 'registered' } });
  new FileResults(store).prepare(work);
  const execute = vi.fn(async () => ({ result: { status: 'passed' } }));
  const mailbox = new BrowserMailbox(store, execute), directory = mailbox.prepare(work);
  mailboxes.push(mailbox); const contextId = JSON.parse(readFileSync(join(directory, 'context.json'), 'utf8')).contextId;
  return { mailbox, directory, execute, contextId };
}
const id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
it('완료된 요청 ID를 다시 제출해도 검증과 이전 응답을 중복 실행하지 않는다', async () => {
  const f = setup(), request = join(f.directory, 'requests', `${id}.json`);
  const content = JSON.stringify({ id, op: 'run', contextId: f.contextId });
  writeFileSync(request, content); f.mailbox.poll();
  await expect.poll(() => existsSync(join(f.directory, 'results', `${id}.json`))).toBe(true);
  writeFileSync(request, content); f.mailbox.poll();
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it('과거 처리 기록 64개가 누적되어도 새 중단 요청을 처리한다', async () => {
  const f = setup();
  const history = Array.from({ length: 64 }, (_, i) => `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000.json.processing`);
  for (const file of history) writeFileSync(join(f.directory, 'requests', file), '{}');
  writeFileSync(join(f.directory, 'requests', `${id}.json`), JSON.stringify({ id, op: 'cancel' }));
  // Directory enumeration order differs by filesystem; old entries may come first.
  enumeration.path = join(f.directory, 'requests'); enumeration.files = [...history, `${id}.json`];
  f.mailbox.poll();
  await expect.poll(() => existsSync(join(f.directory, 'results', `${id}.json`))).toBe(true);
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it('null 요청이 있어도 나머지 정상 상태 조회를 중단하지 않는다', async () => {
  const f = setup();
  writeFileSync(join(f.directory, 'requests', '00000000-0000-0000-0000-000000000000.json'), 'null');
  writeFileSync(join(f.directory, 'requests', `${id}.json`), JSON.stringify({ id, op: 'status' }));
  expect(() => f.mailbox.poll()).not.toThrow();
  await expect.poll(() => existsSync(join(f.directory, 'results', `${id}.json`))).toBe(true);
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it('mailbox wrapper는 passed지만 fresh=false인 explicit success:false를 true로 덮지 않는다', async () => {
  const f = setup(); f.execute.mockResolvedValue({ success: false, result: { status: 'passed', fresh: false } } as any);
  writeFileSync(join(f.directory, 'requests', `${id}.json`), JSON.stringify({ id, op: 'status', contextId: f.contextId })); f.mailbox.poll();
  const path = join(f.directory, 'results', `${id}.json`); await expect.poll(() => existsSync(path)).toBe(true); expect(JSON.parse(readFileSync(path, 'utf8')).success).toBe(false);
  expect(backgroundToolResponse({ success: false, result: { status: 'passed', fresh: false } }).success).toBe(false);
});
it('재시작 recovery는 한 poll의 64개 한도를 유지하면서 65번째 processing도 다음 poll에서 응답한다', async () => {
  const f = setup();
  for (let index = 0; index < 65; index++) { const requestId = `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`; writeFileSync(join(f.directory, 'requests', `${requestId}.json.processing`), JSON.stringify({ id: requestId, op: 'run', contextId: f.contextId })); }
  const restarted = new BrowserMailbox(store, f.execute); mailboxes.push(restarted); restarted.poll();
  const last = join(f.directory, 'results', '00000000-0000-0000-0000-000000000064.json'); expect(existsSync(last)).toBe(false); restarted.poll();
  expect(existsSync(last)).toBe(true); expect(JSON.parse(readFileSync(last, 'utf8'))).toMatchObject({ requestId: '00000000-0000-0000-0000-000000000064', result: { status: 'interrupted' } }); expect(f.execute).not.toHaveBeenCalled();
});
