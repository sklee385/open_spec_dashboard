import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { WorkStore } from '../src/work/store';
import { FileResults } from '../src/work/file-results';
import { BrowserService } from '../src/browser/browser.service';
let store: WorkStore, service: BrowserService;
afterEach(async () => { await service?.onModuleDestroy(); store?.onApplicationShutdown(); delete process.env.DATA_DIR; });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'browser-mailbox-')); mkdirSync(join(root, 'openspec'));
  copyFileSync(resolve('test/fixtures/browser-server.cjs'), join(root, 'server.cjs'));
  process.env.DATA_DIR = join(root, '.data'); store = new WorkStore();
  const work = store.save({ id: 'legacy', sourceId: 'test', projectPath: root, changeName: 'legacy', requestKey: 'legacy', ideaIds: [], phase: 'implementation', state: 'idle', threadId: 'same-legacy-thread', reviewedVersion: null, createdAt: '', updatedAt: '' });
  new FileResults(store).prepare(work); service = new BrowserService(store);
  service.save(work.id, { name: '등록 시나리오', server: { command: 'node', args: ['server.cjs'], url: 'http://127.0.0.1:14321' }, steps: [{ op: 'expectURL', path: '/' }] });
  service.onModuleInit(); return { work, directory: join(work.executionPath!, '.tools/browser-verification') };
}
it('기존 대화의 실제 CLI가 네트워크 없이 등록 시나리오 상태를 조회한다', async () => {
  const f = setup(), child = spawn(process.execPath, [join(f.directory, 'cli.cjs'), 'status'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data.toString(); });
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  expect(code).toBe(0); expect(JSON.parse(output)).toMatchObject({ success: true, scenarioName: '등록 시나리오', result: null });
  expect(store.get(f.work.id)?.threadId).toBe('same-legacy-thread');
}, 10000);
it('유효하지 않은 요청과 이미 처리 중인 제출은 실행하지 않는다', async () => {
  const f = setup(), id = '11111111-1111-1111-1111-111111111111';
  writeFileSync(join(f.directory, 'requests', `${id}.json`), JSON.stringify({ id, op: 'save', server: 'evil' }));
  service.mailbox.poll(); expect(existsSync(join(f.directory, 'results', `${id}.json`))).toBe(false);
  writeFileSync(join(f.directory, 'requests', `${id}.json.processing`), JSON.stringify({ id, op: 'run' }));
  service.mailbox.poll(); expect(store.records(f.work.id, 'browser-verification')).toEqual([]);
  expect(readFileSync(join(f.directory, 'requests', `${id}.json.processing`), 'utf8')).toContain('run');
});
it('처리 이력이 64개 이상 누적되어도 새 요청을 처리한다', async () => {
  const f = setup();
  for (let i = 0; i < 70; i++) writeFileSync(join(f.directory, 'requests', `00000000-0000-0000-0000-${String(i).padStart(12, '0')}.json.processing`), '{}');
  const id = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  writeFileSync(join(f.directory, 'requests', `${id}.json`), JSON.stringify({ id, op: 'status' }));
  service.mailbox.poll();
  await expect.poll(() => existsSync(join(f.directory, 'results', `${id}.json`)), { timeout: 1000 }).toBe(true);
});
it('기존 대화용 CLI로 실제 시나리오를 실행하고 로컬 화면 증거를 전달한다', async () => {
  const f = setup(), probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as any).port; await new Promise<void>(r => probe.close(() => r()));
  const work = store.get(f.work.id)!;
  service.save(work.id, { name: '기존 대화 검증', server: { command: 'node', args: ['server.cjs'], url: `http://127.0.0.1:${port}` }, steps: [{ op: 'goto', path: '/' }, { op: 'expectVisible', target: { role: 'heading', name: '검증' } }] });
  work.browserScenario = store.get(work.id)!.browserScenario; work.state = 'running'; store.save(work);
  const child = spawn(process.execPath, [join(f.directory, 'cli.cjs'), 'run'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data.toString(); });
  const code = await new Promise<number | null>(r => child.once('exit', r)), result = JSON.parse(output);
  expect({ code, status: result.result?.status, error: result.error || result.result?.error }).toEqual({ code: 0, status: 'passed', error: undefined });
  expect(existsSync(result.result.imagePath)).toBe(true); expect(result.result.image).toBeUndefined();
  expect(store.get(work.id)?.threadId).toBe('same-legacy-thread');
}, 120000);
