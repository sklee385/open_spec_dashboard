import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore } from '../src/work/store';
import { FileResults } from '../src/work/file-results';
import { BrowserMailbox } from '../src/browser/browser-mailbox';

let store: WorkStore;
const enumeration = vi.hoisted(() => ({ path: '', files: [] as string[] }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: (...args: any[]) => enumeration.path === String(args[0]) ? enumeration.files : (actual.readdirSync as any)(...args) };
});
afterEach(() => { enumeration.path = ''; enumeration.files = []; store?.onApplicationShutdown(); delete process.env.DATA_DIR; });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'browser-mailbox-regression-'));
  mkdirSync(join(root, 'openspec'));
  process.env.DATA_DIR = join(root, '.data'); store = new WorkStore();
  const work = store.save({ id: 'work', requestKey: 'work', sourceId: 'test', projectPath: root, changeName: 'test', ideaIds: [], phase: 'implementation', state: 'idle', threadId: 'existing-thread', reviewedVersion: null, createdAt: '', updatedAt: '', browserScenario: { name: 'registered' } });
  new FileResults(store).prepare(work);
  const execute = vi.fn(async () => ({ result: { status: 'passed' } }));
  const mailbox = new BrowserMailbox(store, execute), directory = mailbox.prepare(work);
  return { mailbox, directory, execute };
}
const id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
it('완료된 요청 ID를 다시 제출해도 검증과 이전 응답을 중복 실행하지 않는다', async () => {
  const f = setup(), request = join(f.directory, 'requests', `${id}.json`);
  const content = JSON.stringify({ id, op: 'run' });
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
