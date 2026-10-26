const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const drain = () => new Promise(resolve => setImmediate(resolve));
async function page() {
  const elements = Object.fromEntries(['version','state','message','progress','install','check'].map(id => [id, {}]));
  const controls = { value: { state: 'ready', currentVersion: '0.1.0', targetVersion: '0.1.1', percent: 100, message: '' } };
  let refresh, installs = 0;
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'updates-ui.cjs'), 'utf8'), {
    document: { getElementById: id => elements[id] },
    window: { desktopUpdates: {
      async status() { if (controls.statusError) throw new Error('disconnected'); return controls.value; },
      async check() { throw new Error('disconnected'); },
      async install() { installs++; if (controls.installError) throw new Error('disconnected'); controls.value = { ...controls.value, state: 'waiting', message: '다른 업무에 미답변 질문이 있습니다.' }; },
    } }, setInterval(callback) { refresh = callback; },
  });
  await drain(); return { elements, controls, refresh, installs: () => installs };
}
test('설치 준비와 업무 대기 상태는 명시적 버튼으로만 설치를 요청한다', async () => {
  const { elements, installs } = await page();
  assert.equal(installs(), 0); assert.equal(elements.install.disabled, false); assert.equal(elements.check.disabled, true);
  assert.match(elements.version.textContent, /0.1.0.*0.1.1/);
  await elements.install.onclick(); assert.equal(installs(), 1);
  assert.equal(elements.state.textContent, '업무 종료 대기'); assert.match(elements.message.textContent, /미답변 질문/);
  assert.equal(elements.install.disabled, false);
});
test('상태 연결이 끊기면 남아 있던 설치 버튼을 막고 연결 회복 후 다시 표시한다', async () => {
  const { elements, controls, refresh } = await page(); controls.statusError = true;
  await refresh(); assert.equal(elements.install.disabled, true); assert.equal(elements.check.disabled, true);
  assert.match(elements.message.textContent, /연결/);
  controls.statusError = false; await refresh(); assert.equal(elements.install.disabled, false);
});
test('설치·확인 IPC 실패는 처리하고 다음 상태 조회로 회복한다', async () => {
  const { elements, controls, refresh } = await page(); controls.installError = true;
  await assert.doesNotReject(elements.install.onclick()); assert.match(elements.message.textContent, /연결/);
  assert.equal(elements.install.disabled, true);
  controls.value.state = 'idle'; await refresh();
  await assert.doesNotReject(elements.check.onclick()); assert.match(elements.message.textContent, /연결/);
  await refresh(); assert.equal(elements.check.disabled, false);
});
