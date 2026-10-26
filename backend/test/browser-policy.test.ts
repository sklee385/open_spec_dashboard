import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScenario, serverCwd, allowedRequest } from '../src/browser/browser-policy';

export const sample = () => ({ name: '저장 확인', server: { command: 'node', args: ['server.cjs'], url: 'http://127.0.0.1:14321' }, steps: [{ op: 'goto', path: '/' }, { op: 'expectVisible', target: { role: 'heading', name: '검증' } }] });
it('로컬 결과 검사 시나리오를 허용하고 외부 주소·예약 포트·인증 주소를 거부한다', () => {
  expect(parseScenario(sample()).name).toBe('저장 확인');
  for (const url of ['https://example.com', 'http://localhost:14321', 'http://127.0.0.1:13003', 'http://user:pass@127.0.0.1:14321', 'file:///tmp/a', 'http://127.0.0.1:14321/path']) {
    expect(() => parseScenario({ ...sample(), server: { ...sample().server, url } })).toThrow();
  }
  expect(allowedRequest('http://127.0.0.1:14321/api', 'http://127.0.0.1:14321')).toBe(true);
  expect(allowedRequest('http://127.0.0.1:13003/api', 'http://127.0.0.1:14321')).toBe(false);
  expect(allowedRequest('file:///tmp/a', 'http://127.0.0.1:14321')).toBe(false);
});
it('결과 없는 클릭·임의 코드·외부 이동·비밀 환경·모호한 요소 정의를 거부한다', () => {
  for (const value of [
    { ...sample(), steps: [{ op: 'click', target: { role: 'button', name: '저장' } }] },
    { ...sample(), server: { ...sample().server, args: ['-e', 'process.exit()'] } },
    { ...sample(), server: { ...sample().server, env: { DESKTOP_TOKEN: 'secret' } } },
    { ...sample(), steps: [...sample().steps, { op: 'goto', path: '//evil.test' }] },
    { ...sample(), steps: [{ op: 'expectVisible', target: { role: 'button', name: '저장', testId: 'save' } }] },
    { ...sample(), steps: [...sample().steps, { op: 'evaluate', script: 'alert(1)' }] },
  ]) expect(() => parseScenario(value)).toThrow();
});
it('서버 작업 경로의 상위 이동과 심볼릭 링크 이탈을 거부한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-policy-')), outside = mkdtempSync(join(tmpdir(), 'browser-outside-'));
  mkdirSync(join(root, 'app')); symlinkSync(outside, join(root, 'escape'), 'junction');
  expect(serverCwd(root, 'app')).toBe(join(root, 'app'));
  expect(() => serverCwd(root, '..')).toThrow(); expect(() => serverCwd(root, 'escape')).toThrow();
});
