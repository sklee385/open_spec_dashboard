const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRelease } = require('../release.cjs');
test('개인용 배포는 지원 대상·버전 태그·게시 토큰이 없으면 차단한다', () => {
  assert.throws(() => validateRelease({ platform: 'win32', arch: 'arm64', version: '0.1.0', tag: 'v0.1.0', env: {} }), /지원/);
  assert.throws(() => validateRelease({ platform: 'win32', arch: 'x64', version: '0.1.0', tag: 'v0.2.0', env: {} }), /버전/);
  assert.throws(() => validateRelease({ platform: 'darwin', arch: 'arm64', version: '0.1.0', tag: 'v0.1.0', env: {} }), /지원/);
  assert.throws(() => validateRelease({ platform: 'win32', arch: 'x64', version: '0.1.0', tag: 'v0.1.0', env: {} }), /토큰/);
});
test('승인된 대상과 CI 자격 증명 계약만 통과한다', () => {
  const env = { GITHUB_REPOSITORY: 'sklee385/open_spec_dashboard', GH_TOKEN: 'test-publish-token' };
  assert.doesNotThrow(() => validateRelease({ platform: 'win32', arch: 'x64', version: '0.1.0', tag: 'v0.1.0', env }));
  assert.throws(() => validateRelease({ platform: 'win32', arch: 'x64', version: '0.1.0', tag: 'v0.1.0', env: { ...env, GITHUB_REPOSITORY: 'other/repo' } }), /저장소/);
});
