import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore, type Work } from '../src/work/store';
import { FileResults } from '../src/work/file-results';
import { BrowserService } from '../src/browser/browser.service';
import { projectCoordinator } from '../src/projects/coordinator';
import { browserBuildFixture, browserFixtureConfig } from './fixtures/browser-build-fixture';
import { liveBrowser } from '../src/browser/browser-lease';
const mock = vi.hoisted(() => ({ fork: vi.fn(), guard: vi.fn(), stop: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<any>(), fork: mock.fork }));
vi.mock('../src/browser/browser-job', () => ({ guardBrowserProcess: mock.guard }));
vi.mock('../src/browser/browser-process', () => ({ stopOwnedProcess: mock.stop }));
let store: WorkStore, browser: BrowserService, a: Work, b: Work, services: BrowserService[], other: WorkStore | undefined;
let workers: any[];
const saved = { DATA_DIR: process.env.DATA_DIR, CONFIG_PATH: process.env.CONFIG_PATH };
function closed(child: any, acknowledge = true) {
  if (child.exitCode === null) { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); }
  if (acknowledge) child.ack?.({ protocol: 'browser-job-v2', state: 'job-quiescent', workerPid: child.pid, guardPid: child.pid + 1000, activeProcesses: 0, at: new Date().toISOString() });
}
beforeEach(() => {
  workers = []; services = []; other = undefined; mock.fork.mockImplementation(() => { const child: any = Object.assign(new EventEmitter(), { pid: 31000 + workers.length, connected: true, exitCode: null, signalCode: null, stdout: { resume() {} }, stderr: { resume() {} }, send: vi.fn((_value, callback) => callback?.()), kill: vi.fn() }); workers.push(child); return child; });
  mock.guard.mockImplementation(async (child: any) => { let proof: any; const done = new Promise<void>(resolve => { child.ack = (value: any) => { proof = value; resolve(); }; }); return { pid: child.pid + 1000, protocol: 'browser-job-v2', done, get terminationProof() { return proof; }, requestStop: () => closed(child) }; }); mock.stop.mockImplementation(async child => { closed(child); });
  const dir = mkdtempSync(join(tmpdir(), 'blife-')), root = join(dir, 'source'); mkdirSync(root); browserBuildFixture(root, 'a'); browserBuildFixture(root, 'b'); browserFixtureConfig(root, 'fixture'); writeFileSync(join(root, 'server.cjs'), '// host fixture'); process.env.DATA_DIR = join(dir, 'data'); store = new WorkStore();
  const make = (id: string): Work => { const work = store.save({ id, sourceId: 'fixture', projectPath: root, changeName: id, requestKey: id, ideaIds: [], phase: 'verification', state: 'idle', threadId: 'thread-'+id, reviewedVersion: null, createdAt: '', updatedAt: '' }); new FileResults(store).prepare(work); return work; };
  a = make('a'); b = make('b'); browser = new BrowserService(store); services.push(browser);
  const scenario = { name: 'registered', server: { command: 'node', args: ['server.cjs'], url: 'http://127.0.0.1:19421' }, steps: [{ op: 'expectURL', path: '/' }] }; browser.save(a.id, scenario); browser.save(b.id, scenario);
});
afterEach(async () => {
  vi.useRealTimers();
  const pending = services.map(service => (service as any).active).filter(Boolean); for (const active of pending) active.abort.abort(); for (const child of workers) closed(child);
  // Abort our preparation and acknowledge only synthetic guards, then wait for
  // the actual finalizer before closing its DB. Never erase an in-flight owner.
  let settled = false; void Promise.all(pending.map(active => active.done)).then(() => { settled = true; }); await vi.waitFor(() => expect(settled).toBe(true), { timeout: 20000 });
  for (const service of services) await service.onModuleDestroy();
  other?.onApplicationShutdown(); store.onApplicationShutdown(); vi.restoreAllMocks(); vi.clearAllMocks();
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
async function started() { const run = browser.run(a.id); await vi.waitFor(() => { const row = store.records(a.id, 'browser-verification').find(row => row.id === run.id), diagnostic = JSON.stringify({ status: row?.status, error: row?.error, snapshotStatus: row?.snapshotStatus, tmpdir: tmpdir() }); expect(workers[0], diagnostic).toBeDefined(); expect(workers[0].send, diagnostic).toHaveBeenCalled(); }, { timeout: 15000 }); return { run, child: workers[0], active: (browser as any).active, sent: workers[0].send.mock.calls[0][0] }; }
it('같은 실제 DB의 다른 Store도 live browser를 보존하고 두 번째 browser를 busy로 거부한다', async () => {
  const current = await started(); other = new WorkStore(); const second = new BrowserService(other); services.push(second);
  expect(store.records(a.id, 'browser-verification').find(row => row.id === current.run.id)?.status).toBe('running'); expect(() => second.run(b.id)).toThrow(); expect(workers).toHaveLength(1);
  closed(current.child); await current.active.done;
});
it('실행 중 host 사본의 수정·정리만 점유하고 원본·타업무 AI 공간은 잠그지 않는다', async () => {
  const current = await started();
  expect(() => projectCoordinator(store).assertOperationCanStart({ kind: 'workspace', root: current.sent.root })).toThrow();
  await expect((browser as any).snapshots.cleanup(current.sent.snapshot)).rejects.toThrow();
  expect(() => projectCoordinator(store).assertWorkCanStart(store.get(a.id)!)).not.toThrow(); expect(() => projectCoordinator(store).assertWorkCanStart(store.get(b.id)!)).not.toThrow();
  expect(() => projectCoordinator(store).assertOperationCanStart({ kind: 'workspace', root: a.projectPath })).not.toThrow();
  closed(current.child); await current.active.done;
});
it('guard 무응답은 유한하게 done을 끝내되 slot·사본·intent를 unknown으로 보존한다', async () => {
  const current = await started(); let settled = false; void current.active.done.then(() => { settled = true; }); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    closed(current.child, false); await vi.advanceTimersByTimeAsync(20000); expect(settled).toBe(true);
    const slot = store.db.prepare("SELECT data FROM records WHERE id='browser-global-slot'").get() as any; expect(JSON.parse(slot.data).status).toBe('uncertain'); expect(store.records(a.id, 'browser-verification').find(row => row.id === current.run.id)).toMatchObject({ cleanupStatus: 'uncertain', processTerminated: false }); expect(() => browser.run(b.id)).toThrow();
  } finally { vi.useRealTimers(); closed(current.child); }
});
it('terminal DB 실패도 done을 끝내고 종료 witness만 명시 reconcile에 재사용한다', async () => {
  const current = await started(), record = store.record.bind(store); let rejected = false;
  const spy = vi.spyOn(store, 'record').mockImplementation((id, workId, kind, data: any) => { if (!rejected && kind === 'browser-verification' && data.status === 'blocked' && data.cleanupStatus !== 'uncertain') { rejected = true; throw new Error('terminal receipt unavailable'); } return record(id, workId, kind, data); });
  closed(current.child); await current.active.done; spy.mockRestore(); expect(rejected).toBe(true);
  const row = store.records(a.id, 'browser-verification').find(row => row.id === current.run.id)!; expect(row).toMatchObject({ cleanupStatus: 'uncertain', processTerminated: true }); expect(() => browser.run(b.id)).toThrow();
  // Drop the ephemeral witness so this observation must validate the durable tuple.
  liveBrowser(store, a.id)!.proof = undefined; const restarted = new BrowserService(store); services.push(restarted);
  const changed = { ...row, executionOwner: 'foreign-owner' }; store.record(row.id, a.id, 'browser-verification', changed); await expect(restarted.reconcile(a.id, row.id, true)).rejects.toThrow(); store.record(row.id, a.id, 'browser-verification', row);
  const result = await restarted.reconcile(a.id, row.id, true); expect(result).toMatchObject({ status: 'interrupted', processTerminated: true, reconciliation: 'terminated' }); expect(restarted.activity(a.id).busy).toBe(false); expect(store.get(a.id)?.state).toBe('interrupted');
});
it('exit 이후 close 전 IPC는 보존하고 close 이후 늦은 결과는 영수증과 slot을 덮지 않는다', async () => {
  const current = await started(); current.child.exitCode = 0; current.child.emit('exit', 0); current.child.emit('message', { result: { status: 'failed', steps: [], error: 'drained IPC outcome' } }); current.child.emit('close', 0); closed(current.child); await current.active.done;
  const before = JSON.stringify(store.records(a.id, 'browser-verification')), slot = JSON.stringify(store.db.prepare("SELECT data FROM records WHERE id='browser-global-slot'").get());
  current.child.emit('message', { step: { index: 99 }, result: { status: 'passed', id: 'wrong-generation' } });
  expect(store.records(a.id, 'browser-verification').find(row => row.id === current.run.id)).toMatchObject({ status: 'failed', error: 'drained IPC outcome' }); expect(JSON.stringify(store.records(a.id, 'browser-verification'))).toBe(before); expect(JSON.stringify(store.db.prepare("SELECT data FROM records WHERE id='browser-global-slot'").get())).toBe(slot);
});
it('재생성 Service는 영속 running의 PID나 true boolean만으로 종료·복구를 추정하지 않는다', async () => {
  const row = { id: 'unobserved-run', workId: a.id, status: 'running', owner: 'tool', processId: process.pid, processTerminated: true, snapshotStatus: 'retained' }; store.record(row.id, a.id, 'browser-verification', row);
  const kill = vi.spyOn(process, 'kill'), second = new BrowserService(store); services.push(second);
  expect(store.records(a.id, 'browser-verification').find(item => item.id === row.id)).toMatchObject(row); expect(() => second.run(b.id)).toThrow(); await expect(second.reconcile(a.id, row.id, true)).rejects.toThrow(); expect(kill).not.toHaveBeenCalled();
});
it('늦게 관측한 실제 Job 종료는 자동 해제하지 않고 새 Service의 명시 복구만 허용한다', async () => {
  const current = await started(); let done = false; void current.active.done.then(() => { done = true; }); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); closed(current.child, false); await vi.advanceTimersByTimeAsync(20000); vi.useRealTimers(); expect(done).toBe(true);
  const row = store.records(a.id, 'browser-verification').find(item => item.id === current.run.id)!; await expect(browser.reconcile(a.id, row.id, true)).rejects.toThrow();
  closed(current.child); await Promise.resolve(); await Promise.resolve();
  const second = new BrowserService(store); services.push(second); const recovered = await second.reconcile(a.id, row.id, true); expect(recovered.processTerminated).toBe(true); expect(recovered.status).toBe('interrupted'); expect(second.activity(a.id).busy).toBe(false);
});
