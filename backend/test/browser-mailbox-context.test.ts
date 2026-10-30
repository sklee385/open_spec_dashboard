import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore, type Work } from '../src/work/store';
import { FileResults } from '../src/work/file-results';
import { BrowserService } from '../src/browser/browser.service';
import { browserBuildFixture, browserFixtureConfig } from './fixtures/browser-build-fixture';

let store: WorkStore, browser: BrowserService, work: Work, directory: string;
const saved = { DATA_DIR: process.env.DATA_DIR, CONFIG_PATH: process.env.CONFIG_PATH };
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'bctx-')), root = join(dir, 'source'); mkdirSync(root); browserBuildFixture(root, 'a'); browserFixtureConfig(root, 'fixture'); process.env.DATA_DIR = join(dir, 'data'); store = new WorkStore();
  work = { id: 'a', sourceId: 'fixture', projectPath: root, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'implementation', state: 'idle', threadId: 'same-thread', turnId: 'same-turn', reviewedVersion: null, createdAt: '', updatedAt: '' }; store.save(work); new FileResults(store).prepare(work); browser = new BrowserService(store);
  browser.save(work.id, { name: 'registered', server: { command: 'node', args: ['server.cjs'], url: 'http://127.0.0.1:19381' }, steps: [{ op: 'expectURL', path: '/' }] }); work = store.get(work.id)!; work.state = 'running'; store.save(work); directory = join(work.executionPath!, '.tools/browser-verification');
});
afterEach(async () => { (browser as any).active = undefined; vi.restoreAllMocks(); await browser.onModuleDestroy(); store.onApplicationShutdown(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
function contextId() { const path = join(directory, 'context.json'); return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).contextId : undefined; }

it('tool run은 시작한 정확 run의 done과 결과를 고정하고 뒤따른 run을 반환하지 않는다', async () => {
  let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(browser, 'run').mockImplementation((...args: any[]) => {
    const row = { id: 'started-run', workId: work.id, candidateId: null, targetKind: 'work', ...(browser as any).context(work), executionBinding: args[3], status: 'running' }; store.record(row.id, work.id, 'browser-verification', row);
    (browser as any).active = { workId: work.id, row, cancelled: false, abort: new AbortController(), done }; return { id: row.id, status: 'running' };
  });
  const pending = browser.tool(work.id, { op: 'run' });
  await vi.waitFor(() => expect((browser as any).active?.row.id).toBe('started-run'));
  const started = store.records(work.id, 'browser-verification').find(row => row.id === 'started-run')!; store.record(started.id, work.id, 'browser-verification', { ...started, status: 'blocked', processTerminated: true, error: 'original outcome' });
  store.record('next-run', work.id, 'browser-verification', { ...started, id: 'next-run', status: 'passed', processTerminated: true });
  (browser as any).active = { workId: work.id, row: { id: 'next-run' }, cancelled: false, abort: new AbortController(), done: Promise.resolve() }; finish();
  const result = await pending; expect(result.result).toMatchObject({ id: 'started-run', status: 'blocked', error: 'original outcome', fresh: false });
});
it('tool cancel은 Work namespace를 보존하고 가장 최근 타후보 결과를 섞지 않는다', async () => {
  const context = (browser as any).context(work); store.record('work-result', work.id, 'browser-verification', { ...context, candidateId: null, targetKind: 'work', status: 'blocked', processTerminated: true }); store.record('candidate-result', work.id, 'browser-verification', { ...context, candidateId: 'other-candidate', targetKind: 'integration-candidate', status: 'passed', processTerminated: true });
  expect((await browser.tool(work.id, { op: 'cancel' })).result?.id).toBe('work-result');
});
it('재시작 processing은 같은 requestId의 interrupted 응답만 기록하고 새 run을 시작하지 않는다', async () => {
  const id = '11111111-1111-1111-1111-111111111111', run = vi.spyOn(browser, 'run');
  store.record('known-before-restart', work.id, 'browser-verification', { mailboxRequestId: id, executionBinding: { contextId: contextId() }, candidateId: null, targetKind: 'work', status: 'running', processTerminated: false });
  writeFileSync(join(directory, 'requests', `${id}.json.processing`), JSON.stringify({ id, op: 'run', ...(contextId() ? { contextId: contextId() } : {}) }));
  browser.onModuleInit();
  await vi.waitFor(() => expect(existsSync(join(directory, 'results', `${id}.json`))).toBe(true), { timeout: 1500 });
  const response = JSON.parse(readFileSync(join(directory, 'results', `${id}.json`), 'utf8')); expect(response).toMatchObject({ requestId: id, runId: 'known-before-restart', success: false, result: { id: 'known-before-restart', status: 'interrupted', observedStatus: 'running', processTerminated: false } }); expect(run).not.toHaveBeenCalled(); expect(readFileSync(join(directory, 'requests', `${id}.json.processing`), 'utf8')).toContain(id); expect(store.records(work.id, 'browser-verification')[0]).toMatchObject({ status: 'running', processTerminated: false });
});
it('소유 경계 확인이 깨져도 같은 대화의 status/cancel은 보존하고 run만 거부한다', async () => {
  writeFileSync(join(dirname(work.executionPath!), 'identity.json'), JSON.stringify({ workId: 'foreign', projectPath: work.projectPath }));
  await expect(browser.tool(work.id, { op: 'status' })).resolves.toHaveProperty('result'); await expect(browser.tool(work.id, { op: 'cancel' })).resolves.toHaveProperty('result'); await expect(browser.tool(work.id, { op: 'run' })).rejects.toThrow(); expect(store.get(work.id)?.threadId).toBe('same-thread');
});
it('이전 turn의 queued run은 새 컨텍스트에서 실행하지 않고 원래 requestId로 거부한다', async () => {
  const id = '22222222-2222-2222-2222-222222222222', old = contextId(), run = vi.spyOn(browser, 'run');
  writeFileSync(join(directory, 'requests', `${id}.json`), JSON.stringify({ id, op: 'run', contextId: old })); store.save({ ...work, turnId: 'next-turn' }); browser.mailbox.poll();
  const path = join(directory, 'results', `${id}.json`); await vi.waitFor(() => expect(existsSync(path)).toBe(true)); expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ requestId: id, contextId: old, success: false, result: { status: 'blocked' } }); expect(run).not.toHaveBeenCalled(); expect(store.get(work.id)?.threadId).toBe('same-thread');
});
it('타 업무의 host contextId를 복사해도 해당 업무·후보를 실행하거나 조회하지 않는다', async () => {
  const foreign = { ...work, id: 'foreign', requestKey: 'foreign', changeName: 'foreign' }; store.save(foreign); const token = (browser as any).executionBindings().current(foreign.id).contextId, id = '33333333-3333-3333-3333-333333333333', tool = vi.spyOn(browser, 'tool');
  writeFileSync(join(directory, 'requests', `${id}.json`), JSON.stringify({ id, op: 'status', contextId: token })); browser.mailbox.poll(); const path = join(directory, 'results', `${id}.json`); await vi.waitFor(() => expect(existsSync(path)).toBe(true));
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ requestId: id, success: false }); expect(tool).not.toHaveBeenCalled(); expect(store.records(foreign.id, 'browser-verification')).toEqual([]);
});
it('통로 출력이 공유 파일로 바뀌면 원본을 쓰지 않고 host 응답과 status/cancel을 보존한다', async () => {
  const id = '44444444-4444-4444-4444-444444444444', shadow = join(dirname(work.projectPath), 'shared-response.json'); writeFileSync(shadow, 'keep-shared');
  writeFileSync(join(directory, 'requests', `${id}.json`), JSON.stringify({ id, op: 'status', contextId: contextId() })); browser.mailbox.poll(); linkSync(shadow, join(directory, 'results', `${id}.json`));
  await vi.waitFor(() => expect(store.records(work.id, 'browser-mailbox-request').find(row => row.requestId === id)?.status).toBe('completed'));
  expect(readFileSync(shadow, 'utf8')).toBe('keep-shared'); await expect(browser.tool(work.id, { op: 'status' })).resolves.toHaveProperty('result'); await expect(browser.tool(work.id, { op: 'cancel' })).resolves.toHaveProperty('result');
});
