import { expect, it } from 'vitest';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { runScenario } from '../src/browser/browser-runner';
import type { Scenario } from '../src/browser/browser-policy';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-real-'));
  copyFileSync(resolve('test/fixtures/browser-server.cjs'), join(root, 'server.cjs'));
  const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port; await new Promise<void>(r => server.close(() => r()));
  const scenario: Scenario = { name: '실제 저장', server: { command: 'node', args: ['server.cjs'], url: `http://127.0.0.1:${port}` }, steps: [
    { op: 'goto', path: '/' }, { op: 'fill', target: { role: 'textbox', name: '이름' }, value: '테스트' },
    { op: 'click', target: { role: 'button', name: '저장' } }, { op: 'expectText', target: { role: 'status', name: '결과' }, value: '저장됨' },
    { op: 'reload' }, { op: 'expectValue', target: { role: 'textbox', name: '이름' }, value: '테스트' },
  ] };
  return { root, scenario };
}
it('실제 headless Chromium으로 저장·새로고침·화면 캡처를 확인한다', async () => {
  const f = await fixture(), result = await runScenario(f.scenario, f.root, new AbortController().signal);
  expect({ status: result.status, error: result.error }).toEqual({ status: 'passed', error: undefined }); expect(result.steps).toHaveLength(6);
  expect(result.image).toMatch(/^data:image\/jpeg;base64,/); expect(result.browser).toContain('Chromium');
}, 180000);
it('잘못된 예상값은 실패하고 이후 단계를 실행하지 않는다', async () => {
  const f = await fixture(); f.scenario.steps = [{ op: 'goto', path: '/' }, { op: 'expectText', target: { role: 'heading', name: '검증' }, value: '잘못됨' }, { op: 'reload' }];
  const result = await runScenario(f.scenario, f.root, new AbortController().signal);
  expect(result.status).toBe('failed'); expect(result.steps).toHaveLength(2); expect(result.steps[1].status).toBe('failed');
}, 180000);
it('모호한 버튼과 허용하지 않은 하위 리소스 통신을 감지한다', async () => {
  const f = await fixture(); f.scenario.steps[0] = { op: 'goto', path: '/ambiguous' };
  const ambiguous = await runScenario(f.scenario, f.root, new AbortController().signal);
  expect({ status: ambiguous.status, error: ambiguous.error, steps: ambiguous.steps.map(row => row.op) }).toEqual({ status: 'failed', error: '시나리오 단계가 실패했습니다. 단계와 화면을 확인해 주세요', steps: ['goto', 'fill', 'click'] });
  f.scenario.steps = [{ op: 'goto', path: '/external' }, { op: 'expectVisible', target: { role: 'heading', name: '검증' } }];
  expect((await runScenario(f.scenario, f.root, new AbortController().signal)).status).toBe('blocked');
}, 180000);
it('점유된 포트를 재사용하지 않으며 사용자 중단을 통과로 표시하지 않는다', async () => {
  const f = await fixture(), occupied = createServer();
  await new Promise<void>(r => occupied.listen(Number(new URL(f.scenario.server.url).port), '127.0.0.1', r));
  try { expect((await runScenario(f.scenario, f.root, new AbortController().signal)).status).toBe('blocked'); }
  finally { await new Promise<void>(r => occupied.close(() => r())); }
  const abort = new AbortController(); abort.abort();
  expect((await runScenario(f.scenario, f.root, abort.signal)).status).toBe('interrupted');
}, 180000);
it('HTTP 리다이렉트가 다른 로컬 포트에 실제 요청을 보내기 전에 차단한다', async () => {
  const f = await fixture(); let requests = 0;
  const outside = httpServer((_req, res) => { requests++; res.end('<h1>검증</h1>'); });
  await new Promise<void>(r => outside.listen(0, '127.0.0.1', r));
  f.scenario.server.args.push(String((outside.address() as any).port));
  f.scenario.steps = [{ op: 'goto', path: '/redirect-local' }, { op: 'expectVisible', target: { role: 'heading', name: '검증' } }];
  try { expect((await runScenario(f.scenario, f.root, new AbortController().signal)).status).toBe('blocked'); expect(requests).toBe(0); }
  finally { outside.closeAllConnections(); await new Promise<void>(r => outside.close(() => r())); }
}, 180000);
it('허용된 origin의 SSE와 WebSocket 스트리밍을 유지한다', async () => {
  const f = await fixture(); f.scenario.steps = [{ op: 'goto', path: '/stream' },
    { op: 'expectText', target: { testId: 'stream' }, value: 'streamed' },
    { op: 'expectText', target: { testId: 'socket' }, value: 'socket ready' }];
  const result = await runScenario(f.scenario, f.root, new AbortController().signal);
  expect({ status: result.status, error: result.error }).toEqual({ status: 'passed', error: undefined });
}, 180000);
it('루트가 같은 사이트로 리다이렉트하는 테스트 서버도 준비하고 검증한다', async () => {
  const f = await fixture(); f.scenario.server.args.push('0', 'root-redirect');
  f.scenario.steps = [{ op: 'goto', path: '/' }, { op: 'expectURL', path: '/home' }, { op: 'expectVisible', target: { role: 'heading', name: '검증' } }];
  const result = await runScenario(f.scenario, f.root, new AbortController().signal);
  expect({ status: result.status, error: result.error }).toEqual({ status: 'passed', error: undefined });
}, 180000);
