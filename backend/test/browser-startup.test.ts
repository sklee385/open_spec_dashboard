import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { runScenario } from '../src/browser/browser-runner';
import type { Scenario } from '../src/browser/browser-policy';
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('../src/browser/browser-runtime', async original => ({ ...await original<typeof import('../src/browser/browser-runtime')>(), browserRuntime: () => ({ chromium: { launch } }) }));
beforeEach(() => { launch.mockReset(); });
afterEach(() => { vi.useRealTimers(); });
const native = () => new Error('browserType.launch: browser closed\n<process did exit: exitCode=3221225477, signal=null>');
async function run(signal = new AbortController().signal) {
  const root = mkdtempSync(join(tmpdir(), 'browser-startup-'));
  copyFileSync(resolve('test/fixtures/browser-server.cjs'), join(root, 'server.cjs'));
  const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port; await new Promise<void>(r => server.close(() => r()));
  const scenario: Scenario = { name: 'startup', server: { command: 'node', args: ['server.cjs'], url: `http://127.0.0.1:${port}` }, steps: [{ op: 'goto', path: '/' }, { op: 'expectVisible', target: { role: 'heading', name: '검증' } }] };
  return runScenario(scenario, root, signal);
}
it.skipIf(process.platform !== 'win32')('확인된 Windows 네이티브 시작 충돌만 한 번 회복하고 입력 단계는 실행하지 않는다', async () => {
  launch.mockRejectedValueOnce(native()).mockRejectedValueOnce(new Error('second launch failed'));
  const result = await run();
  expect(launch).toHaveBeenCalledTimes(2);
  expect(launch.mock.calls.every(([options]) => options.chromiumSandbox === true && options.timeout === 30000)).toBe(true);
  expect(result).toMatchObject({ status: 'blocked', error: 'second launch failed', steps: [], startupAttempts: 2, startupRecovery: 'windows-native-startup-crash' });
});
it.skipIf(process.platform !== 'win32')('네이티브 시작 충돌이 계속되어도 두 번 뒤 차단한다', async () => {
  launch.mockRejectedValue(native());
  expect(await run()).toMatchObject({ status: 'blocked', steps: [], startupAttempts: 2 });
  expect(launch).toHaveBeenCalledTimes(2);
});
it.each(['Timeout 10000ms exceeded\n<process did exit: exitCode=3221225477>', 'EACCES permission denied\n<process did exit: exitCode=3221225477>', 'ordinary launch failure'])('%s는 시작을 반복하지 않는다', async message => {
  const error = new Error(message); if (message.startsWith('Timeout')) error.name = 'TimeoutError';
  launch.mockRejectedValue(error); await run(); expect(launch).toHaveBeenCalledTimes(1);
});
it('사용자 중단 뒤에는 시작을 다시 시도하지 않는다', async () => {
  const controller = new AbortController();
  launch.mockImplementation(async () => { controller.abort(); throw native(); });
  expect(await run(controller.signal)).toMatchObject({ status: 'interrupted', steps: [] });
  expect(launch).toHaveBeenCalledTimes(1);
});
it('Windows 강제 정리가 45초 걸려도 종료 확인 뒤 원래 결과를 보존한다', async () => {
  let started!: () => void;
  const closing = new Promise<void>(resolve => { started = resolve; });
  launch.mockResolvedValue({ version: () => 'fixture', newContext: async () => { throw new Error('context fixture failure'); }, close: () => {
    vi.useFakeTimers(); started();
    return new Promise<void>(resolve => setTimeout(resolve, 45000));
  } });
  const result = run(); await closing;
  await vi.advanceTimersByTimeAsync(45000); vi.useRealTimers();
  expect(await result).toMatchObject({ status: 'blocked', error: 'context fixture failure' });
}, 15000);
it('종료가 끝내 확인되지 않으면 제한 시간 뒤 차단한다', async () => {
  let started!: () => void;
  const closing = new Promise<void>(resolve => { started = resolve; });
  launch.mockResolvedValue({ version: () => 'fixture', newContext: async () => { throw new Error('context fixture failure'); }, close: () => {
    vi.useFakeTimers(); started(); return new Promise<void>(() => {});
  } });
  const result = run(); await closing;
  await vi.advanceTimersByTimeAsync(60001); vi.useRealTimers();
  expect(await result).toMatchObject({ status: 'blocked', error: '브라우저 종료를 확인하지 못했습니다' });
}, 15000);
