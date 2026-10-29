const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopApi } = require('../api-client.cjs');

function fixture(status, data = {}) { return createDesktopApi({ child: () => ({ sessionPort: 1234, exitCode: null }), token: 'fixture-token', fetchImpl: async () => ({ ok: status === 200, status, json: async () => data }) }); }
test('인증·서버 오류를 작업 중으로 오인하지 않고 충돌에서만 차단 사유를 전달한다', async () => {
  await assert.rejects(fixture(401)('prepare', 'POST'), error => error.code === 'authentication' && !/작업 중/.test(error.message));
  await assert.rejects(fixture(500, { message: 'PRIVATE_ERROR' })('prepare', 'POST'), error => error.code === 'service-error' && !/PRIVATE_ERROR/.test(error.message));
  await assert.rejects(fixture(409, { blockers: [{ workId: 'w', reasons: ['미처리 질문'] }] })('prepare', 'POST'), error => error.code === 'busy' && error.blockers[0].workId === 'w');
});
test('진단 및 복구 API는 고정 앱 인증을 사용하고 JSON 입력을 전달한다', async () => {
  let options;
  const api = createDesktopApi({ child: () => ({ sessionPort: 1234, exitCode: null }), token: 'fixture-token', fetchImpl: async (_url, value) => { options = value; return { ok: true, status: 200, json: async () => ({ safeMode: false }) }; } });
  assert.equal((await api('safe-mode', 'POST', { enabled: false })).safeMode, false);
  assert.equal(options.headers['x-desktop-token'], 'fixture-token');
  assert.deepEqual(JSON.parse(options.body), { enabled: false });
});
