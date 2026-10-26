const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeUpdatePolicy, allowPersonalUpdates } = require('../update-policy.cjs');

test('무설치 정책은 설치형과 분리하고 정확한 무설치 패키지만 활성화한다', () => {
  const { allowPortableUpdates } = require('../update-policy.cjs');
  const policy = makeUpdatePolicy(true, { portable: true });
  assert.equal(policy.mode, 'portable-github');
  assert.equal(allowPersonalUpdates(policy, true), false);
  assert.equal(allowPortableUpdates(policy, true), true);
  assert.equal(allowPortableUpdates(policy, false), false);
  assert.equal(allowPortableUpdates(makeUpdatePolicy(true), true), false);
  for (const wrong of [{...policy,repository:'other/repo'},{...policy,updatesEnabled:'true'},undefined]) assert.equal(allowPortableUpdates(wrong,true),false);
});
test('인증서 없이 명시한 개인용 패키지만 업데이트를 활성화한다', () => {
  const policy = makeUpdatePolicy(true);
  assert.equal(allowPersonalUpdates(policy, true), true);
  assert.equal(allowPersonalUpdates(policy, false), false);
  assert.equal(allowPersonalUpdates(makeUpdatePolicy(false), true), false);
  for (const wrong of [undefined, {}, { signedRelease: true }, { ...policy, repository: 'other/repo' }, { ...policy, mode: 'unknown' }, { ...policy, updatesEnabled: 'true' }]) assert.equal(allowPersonalUpdates(wrong, true), false);
  assert.equal(JSON.stringify(policy).includes('TOKEN'), false);
});
test('개인용 빌드는 NSIS 인증서 검증만 끄고 고정 GitHub 피드를 유지한다', () => {
  const config = require('../electron-builder.cjs');
  assert.equal(config.win.forceCodeSigning, false);
  assert.equal(config.win.verifyUpdateCodeSignature, false);
  assert.equal(config.publish.owner, 'sklee385');
  assert.equal(config.publish.repo, 'open_spec_dashboard');
  assert.equal(config.publish.provider, 'github');
});
