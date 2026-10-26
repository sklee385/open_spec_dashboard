import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { WorkStore } from '../src/work/store';
import { FileResults } from '../src/work/file-results';
import { BrowserService } from '../src/browser/browser.service';

let store: WorkStore;
const services: BrowserService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.onModuleDestroy(); store?.onApplicationShutdown(); delete process.env.DATA_DIR; });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'browser-service-')); mkdirSync(join(root, 'openspec'));
  copyFileSync(resolve('test/fixtures/browser-server.cjs'), join(root, 'server.cjs'));
  process.env.DATA_DIR = join(root, '.data'); store = new WorkStore();
  const work = store.save({ id: 'browser', sourceId: 'test', projectPath: root, changeName: 'browser', requestKey: 'browser', ideaIds: [], phase: 'implementation', state: 'idle', threadId: 'preserved', reviewedVersion: null, createdAt: '', updatedAt: '' });
  const files = new FileResults(store); files.prepare(work);
  const scenario = { name: '검증', server: { command: 'node', args: ['server.cjs'], url: 'http://127.0.0.1:14321' }, steps: [{ op: 'goto', path: '/' }, { op: 'expectVisible', target: { role: 'heading', name: '검증' } }] };
  const service = new BrowserService(store); services.push(service); return { service, work, files, scenario };
}
it('시나리오를 저장해도 대화를 보존하고 AI가 계획을 변경하는 연산은 거부한다', async () => {
  const f = setup(); f.service.save(f.work.id, f.scenario);
  expect(f.service.status(f.work.id).scenario).toMatchObject({ name: '검증' });
  expect(store.get(f.work.id)?.threadId).toBe('preserved');
  await expect(f.service.tool(f.work.id, { op: 'save', scenario: f.scenario })).rejects.toThrow();
  expect(() => f.service.assertPassed(store.get(f.work.id)!)).toThrow();
});
it('시나리오나 코드가 달라지면 과거 통과를 무효화한다', () => {
  const f = setup(); f.service.save(f.work.id, f.scenario);
  const identity = f.service.identity(store.get(f.work.id)!);
  store.record('old', f.work.id, 'browser-verification', { ...identity, status: 'passed' });
  expect(f.service.status(f.work.id).results[0].fresh).toBe(true);
  f.service.assertPassed(store.get(f.work.id)!);
  writeFileSync(join(f.files.path(f.work), 'changed.txt'), 'changed');
  expect(f.service.status(f.work.id).results[0].fresh).toBe(false);
  expect(() => f.service.assertPassed(store.get(f.work.id)!)).toThrow();
});
it('재시작 시 진행 중 결과를 중단 상태로 복구한다', () => {
  const f = setup(); store.record('lost', f.work.id, 'browser-verification', { status: 'running' });
  new BrowserService(store);
  expect(store.records(f.work.id, 'browser-verification')[0].status).toBe('interrupted');
});
it('독립 실행기로 실제 검증하고 동시 실행을 막은 뒤 소유 자원을 정리한다', async () => {
  const f = setup(), probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as any).port; await new Promise<void>(r => probe.close(() => r()));
  f.scenario.server.url = `http://127.0.0.1:${port}`; f.service.save(f.work.id, f.scenario);
  f.service.run(f.work.id);
  expect(() => f.service.run(f.work.id)).toThrow();
  await expect.poll(() => f.service.status(f.work.id).running, { timeout: 100000 }).toBe(false);
  const latest = f.service.status(f.work.id).results.at(-1);
  expect({ status: latest?.status, error: latest?.error }).toEqual({ status: 'passed', error: undefined });
  expect(latest?.fresh).toBe(true); expect(store.get(f.work.id)?.threadId).toBe('preserved');
  await f.service.onModuleDestroy();
}, 120000);
it('실행 중 중단하면 같은 입력을 반복하지 않고 중단 결과를 보존한다', async () => {
  const f = setup(); f.service.save(f.work.id, f.scenario); f.service.run(f.work.id);
  expect(await f.service.cancel(f.work.id)).toMatchObject({ requested: true });
  expect(f.service.status(f.work.id).results.at(-1)?.status).toBe('interrupted');
  expect(store.get(f.work.id)?.state).toBe('interrupted'); await f.service.onModuleDestroy();
}, 20000);
it('실행기 강제 종료 시 Job 가드가 남은 테스트 서버까지 정리한다', async () => {
  const f = setup(), probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as any).port; await new Promise<void>(r => probe.close(() => r()));
  f.scenario.server.url = `http://127.0.0.1:${port}`;
  f.scenario.steps.push({ op: 'expectText', target: { role: 'heading', name: '검증' }, value: 'never' } as any);
  f.service.save(f.work.id, f.scenario); f.service.run(f.work.id);
  await expect.poll(() => f.service.status(f.work.id).results.at(-1)?.steps?.length || 0, { timeout: 20000 }).toBeGreaterThan(0);
  (f.service as any).active.child.kill('SIGKILL');
  await expect.poll(() => f.service.status(f.work.id).running, { timeout: 10000 }).toBe(false);
  expect(f.service.status(f.work.id).results.at(-1)?.status).toBe('blocked');
  const available = createServer(); await new Promise<void>((resolve, reject) => { available.once('error', reject); available.listen(port, '127.0.0.1', resolve); });
  await new Promise<void>(r => available.close(() => r())); await f.service.onModuleDestroy();
}, 120000);
