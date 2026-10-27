const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { RendererRecovery } = require('../renderer-recovery.cjs');

function fixture(options = {}) {
  const window = new EventEmitter(); window.webContents = new EventEmitter();
  window.isDestroyed = () => false;
  const prompts = [], logs = [], timers = new Map(); let reloads = 0, sequence = 0;
  const stopping = { value: false };
  const recovery = new RendererRecovery({ window, dialog: { async showMessageBox(_window, value) { prompts.push(value); return { response: options.response ?? 1 }; } },
    reload: async () => { reloads++; if (options.reloadError) throw Error('fixture'); }, log: value => logs.push(value),
    isStopping: () => stopping.value, setTimer: fn => { timers.set(++sequence, fn); return sequence; }, clearTimer: id => timers.delete(id), ...options });
  return { window, recovery, prompts, logs, timers, stopping, reloads: () => reloads };
}

test('중복 장애는 하나의 네이티브 안내로 합치고 취소 시 재로드하지 않는다', async () => {
  const f = fixture();
  await Promise.all([f.recovery.report('renderer-crashed'), f.recovery.report('unresponsive')]);
  assert.equal(f.prompts.length, 1); assert.equal(f.reloads(), 0);
  assert.match(f.prompts[0].detail, /미저장/); assert.match(f.prompts[0].detail, /대화 서버/);
  assert.equal(f.prompts[0].defaultId, 1);
});

test('명시적으로 선택한 경우에만 화면을 한 번 재로드하고 실패를 한 번 안내한다', async () => {
  const f = fixture({ response: 0, reloadError: true });
  await f.recovery.report('load-failed');
  assert.equal(f.reloads(), 1); assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1].message, /불러오지 못/);
});

test('명시적으로 선택한 복구 재로드 동안만 미저장 입력 폐기를 허용하고 실패해도 보호를 복원한다', async () => {
  let during;
  const f = fixture({ response: 0, reload: async () => { during = f.recovery.reloading; throw Error('fixture'); } });
  assert.notEqual(f.recovery.reloading, true);
  await f.recovery.report('unresponsive');
  assert.equal(during, true);
  assert.equal(f.recovery.reloading, false);
});

test('React 준비 응답은 지연 감시를 해제하고 다시 로드할 때 감시를 재개한다', async () => {
  const f = fixture();
  f.window.webContents.emit('did-start-loading'); assert.equal(f.timers.size, 1);
  f.recovery.ready(); assert.equal(f.timers.size, 0);
  f.window.webContents.emit('did-start-loading');
  await [...f.timers.values()][0]();
  assert.equal(f.prompts.length, 1); assert.match(f.logs.join(' '), /ready-timeout/);
  f.recovery.dispose(); assert.equal(f.timers.size, 0);
});

test('주 프레임 실패·렌더러 종료·응답 없음을 감지하고 하위 프레임과 탐색 취소는 무시한다', async () => {
  const f = fixture();
  f.window.webContents.emit('did-fail-load', {}, -105, '', '', false);
  f.window.webContents.emit('did-fail-load', {}, -3, '', '', true);
  assert.equal(f.prompts.length, 0);
  f.window.webContents.emit('did-fail-load', {}, -105, '', '', true);
  await f.recovery.pending;
  f.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' }); await f.recovery.pending;
  f.window.emit('unresponsive'); await f.recovery.pending;
  assert.equal(f.prompts.length, 3);
});

test('종료·설치 중이거나 창이 닫힌 뒤에는 복구하지 않고 대화상자 뒤에도 종료 상태를 다시 확인한다', async () => {
  const f = fixture({ response: 0 }); f.stopping.value = true;
  await f.recovery.report('crashed'); assert.equal(f.prompts.length, 0);
  f.stopping.value = false;
  f.recovery.dialog.showMessageBox = async () => { f.stopping.value = true; return { response: 0 }; };
  await f.recovery.report('crashed'); assert.equal(f.reloads(), 0);
  f.window.emit('closed'); f.stopping.value = false;
  await f.recovery.report('crashed'); assert.equal(f.reloads(), 0);
});
