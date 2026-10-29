import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../src/work/store';
import { FileResults } from '../src/work/file-results';
import { BrowserService } from '../src/browser/browser.service';
import { projectCoordinator } from '../src/projects/coordinator';
import { VerificationSnapshots } from '../src/browser/verification-snapshot';
const mock = vi.hoisted(() => ({ fork: vi.fn(), guard: vi.fn(), stop: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<any>(), fork: mock.fork }));
vi.mock('../src/browser/browser-job', () => ({ guardBrowserProcess: mock.guard }));
vi.mock('../src/browser/browser-process', () => ({ stopOwnedProcess: mock.stop }));
let store: WorkStore, service: BrowserService, dir: string, child: any;
beforeEach(() => {
  child = Object.assign(new EventEmitter(), { pid: 77777, connected: true, stdout: { resume() {} }, stderr: { resume() {} }, send: vi.fn((_value, callback) => callback?.()) });
  mock.fork.mockReturnValue(child); mock.guard.mockResolvedValue({ done: Promise.resolve() }); mock.stop.mockImplementation(async () => { child.emit('exit', 0); });
  dir = mkdtempSync(join(tmpdir(), 'browser-snapshot-service-')); process.env.DATA_DIR = join(dir, 'data');
  const root = join(dir, 'source'); mkdirSync(root); writeFileSync(join(root, 'server.cjs'), 'source');
  store = new WorkStore(); const work = store.save({ id: 'a', sourceId: 's', projectPath: root, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'implementation', state: 'idle', threadId: 'same-thread', turnId: 'same-turn', reviewedVersion: null, createdAt: '', updatedAt: '' });
  new FileResults(store).prepare(work); service = new BrowserService(store);
  service.save('a', { name: 'test', server: { command: 'node', args: ['server.cjs'], url: 'http://127.0.0.1:14599' }, steps: [{ op: 'goto', path: '/' }, { op: 'expectVisible', target: { role: 'heading', name: 'test' } }] });
});
afterEach(async () => { if (service.activity('a').running) { child.emit('exit', 0); await vi.waitFor(() => expect(service.activity('a').running).toBe(false)); } await service.onModuleDestroy(); store.onApplicationShutdown(); delete process.env.DATA_DIR; rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); });
async function finish() { child.emit('message', { result: { status: 'passed', steps: [] } }); child.emit('exit', 0); await vi.waitFor(() => expect(service.activity('a').running).toBe(false)); return (await service.status('a')).results.at(-1)!; }
it('같은 AI 턴의 잠금을 다시 취득하지 않고 호스트 사본에서 실행한다', async () => {
  const work = store.get('a')!; work.state = 'running'; store.save(work);
  service.run('a', 'tool'); await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
  const sent = child.send.mock.calls[0][0];
  expect(sent.root).not.toBe(work.executionPath); expect(sent.root.startsWith(process.env.DATA_DIR!)).toBe(true);
  expect(readFileSync(join(sent.root, 'server.cjs'), 'utf8')).toBe('source');
  expect(() => projectCoordinator(store).assertActivityCanStart({ ...work, id: 'independent', executionPath: join(dir, 'other'), projectPath: join(dir, 'other') })).not.toThrow();
  const result = await finish();
  expect(result).toMatchObject({ status: 'passed', fresh: true, workId: 'a', threadId: 'same-thread', turnId: 'same-turn' });
  expect(result.environmentId).toBeTruthy(); expect(existsSync(sent.root)).toBe(false);
  expect(store.get('a')).toMatchObject({ state: 'running', threadId: 'same-thread', turnId: 'same-turn' });
});
it.each(['source', 'scenario', 'turn', 'mutation', 'snapshot'] as const)('%s 변경은 통과 결과를 stale로 무효화한다', async kind => {
  service.run('a'); await vi.waitFor(() => expect(child.send).toHaveBeenCalled()); const sent = child.send.mock.calls[0][0], work = store.get('a')!;
  if (kind === 'source') writeFileSync(join(work.executionPath!, 'server.cjs'), 'changed');
  if (kind === 'snapshot') writeFileSync(join(sent.root, 'server.cjs'), 'changed');
  if (kind === 'scenario') (work.browserScenario as any).name = 'changed';
  if (kind === 'turn') work.turnId = 'new-turn';
  if (kind === 'mutation') work.sourceMutationVersion = 1;
  store.save(work);
  expect((await finish()).status).toBe('stale'); await expect(service.assertPassed(store.get('a')!)).rejects.toThrow();
});
it('원본 변경 없이 status/cancel을 유지하고 tool 소유 업무 상태를 바꾸지 않는다', async () => {
  const work = store.get('a')!; work.state = 'running'; store.save(work); service.run('a', 'tool'); await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
  expect((await service.tool('a', { op: 'status' })).running).toBe(true);
  const cancelled = service.cancel('a'); child.emit('exit', 0); expect(await cancelled).toEqual({ requested: true });
  expect((await service.status('a')).results.at(-1)?.status).toBe('interrupted'); expect(store.get('a')?.state).toBe('running');
});
it('임의 경로·명령을 CLI/도구 입력에 넣어도 원본 실행으로 전환하지 않는다', async () => {
  await expect(service.tool('a', { op: 'run', root: store.get('a')!.executionPath })).rejects.toThrow();
  expect(mock.fork).not.toHaveBeenCalled();
});
it('정상 턴 종료 뒤에도 같은 소스의 통과 결과를 유지한다', async () => {
  let current: unknown = { generation: 'generation-a', state: 'active' };
  service.setExecutionContextProvider('fixture', () => current);
  service.run('a'); await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
  expect((await finish()).status).toBe('passed');
  current = null;
  expect((await service.status('a')).results.at(-1)?.fresh).toBe(true);
});
it('검증 중 연결 세대 변경은 stale로 남긴다', async () => {
  let generation = 'a'; service.setExecutionContextProvider('fixture', () => generation);
  service.run('a'); await vi.waitFor(() => expect(child.send).toHaveBeenCalled()); generation = 'b';
  expect((await finish()).status).toBe('stale');
});
it('복사 준비 중 취소는 실행기를 시작하지 않고 busy와 상태를 해제한다', async () => {
  service.run('a'); expect(service.activity('a').running).toBe(true);
  expect(await service.cancel('a')).toEqual({ requested: true });
  expect(mock.fork).not.toHaveBeenCalled(); expect(service.activity('a').running).toBe(false);
  expect(store.get('a')?.state).toBe('interrupted');
  expect(store.records('a', 'browser-verification').at(-1)?.status).toBe('interrupted');
});
it('준비 오류가 나도 상태를 복구하고 다음 요청을 막지 않는다', async () => {
  process.env.DATA_DIR = join(store.get('a')!.projectPath, '.data');
  service.run('a'); await vi.waitFor(() => expect(service.activity('a').running).toBe(false));
  expect(mock.fork).not.toHaveBeenCalled(); expect(store.get('a')?.state).toBe('idle');
  expect(store.records('a', 'browser-verification').at(-1)).toMatchObject({ status: 'blocked', snapshotStatus: 'unavailable' });
  process.env.DATA_DIR = join(dir, 'data'); service.run('a'); await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
  expect((await finish()).status).toBe('passed');
});
it('원본을 바꾸며 취소해도 전체 해시를 기다리지 않고 interrupted를 유지한다', async () => {
  service.run('a'); await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
  writeFileSync(join(store.get('a')!.executionPath!, 'server.cjs'), 'changed');
  const done = service.cancel('a'); child.emit('exit', 0); await done;
  expect(store.records('a', 'browser-verification').at(-1)?.status).toBe('interrupted');
});
it('종료 후 최종 해시 확인 중 취소해도 passed를 저장하지 않고 즉시 중단한다', async () => {
  let releaseHash!: () => void, entered = false;
  const match = vi.spyOn(VerificationSnapshots.prototype, 'matches').mockImplementation((_snapshot, _root, signal) => new Promise<boolean>(resolve => {
    entered = true; releaseHash = () => resolve(true); signal?.addEventListener('abort', () => resolve(false), { once: true });
  }));
  try {
    service.run('a'); await vi.waitFor(() => expect(child.send).toHaveBeenCalled());
    child.emit('message', { result: { status: 'passed', steps: [] } }); child.emit('exit', 0);
    await vi.waitFor(() => expect(entered).toBe(true));
    const cancelled = service.cancel('a'); const fast = await Promise.race([cancelled.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 200))]);
    releaseHash(); await cancelled;
    expect(fast).toBe(true); expect(store.records('a', 'browser-verification').at(-1)?.status).toBe('interrupted');
  } finally { match.mockRestore(); }
});
it('완료 검증은 변경 전 시작한 상태 조회 해시를 재사용하지 않는다', async () => {
  const identity = await service.identity(store.get('a')!);
  store.record('passed', 'a', 'browser-verification', { ...identity, status: 'passed' });
  let releaseStatus!: (value: string) => void;
  const real = VerificationSnapshots.prototype.revision;
  const scan = vi.spyOn(VerificationSnapshots.prototype, 'revision');
  scan.mockImplementationOnce(() => new Promise<string>(resolve => { releaseStatus = resolve; })).mockImplementation(real);
  try {
    const oldStatus = service.status('a'); expect(scan).toHaveBeenCalledTimes(1);
    writeFileSync(join(store.get('a')!.executionPath!, 'server.cjs'), 'changed after status scan started');
    const gate = service.assertPassed(store.get('a')!).then(() => null, error => error);
    releaseStatus(identity.revision); await oldStatus;
    expect(await gate).toBeInstanceOf(Error);
  } finally { scan.mockRestore(); }
});
