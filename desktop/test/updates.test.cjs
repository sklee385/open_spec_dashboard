const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateManager, startUpdateChecks } = require('../updates.cjs');
function setup(overrides = {}) {
  const updater = new EventEmitter(); updater.checkForUpdates = async () => {}; updater.quitAndInstall = () => { updater.installed = true; };
  const service = { prepared: 0, stopped: 0, cancelled: 0 };
  const manager = new UpdateManager({ updater, enabled: true, prepare: async () => { service.prepared++; }, stop: async () => { service.stopped++; }, cancel: async () => { service.cancelled++; }, ...overrides });
  return { manager, updater, service };
}

test('종료 대기 중 긴급 종료 잠금이 생기면 설치 인계 없이 취소한다', async () => {
  let emergency = false, finishStop;
  const { manager, updater, service } = setup({
    stop: () => new Promise(resolve => { finishStop = resolve; }),
    assertInstallAllowed: () => { if (emergency) throw Error('emergency'); },
  });
  updater.emit('update-downloaded', { version: '99.0.0' });
  const installing = manager.install();
  await new Promise(resolve => setImmediate(resolve));
  emergency = true; finishStop(); await installing;
  assert.equal(updater.installed, undefined); assert.equal(manager.installHandoff, false);
  assert.equal(service.cancelled, 1); assert.equal(manager.snapshot().state, 'error');
});

test('설치 공급자 호출 전에 인계 상태를 고정하고 실패 시 해제한다', async () => {
  const { manager, updater, service } = setup();
  updater.quitAndInstall = async () => { assert.equal(manager.installHandoff, true); throw Error('handoff failed'); };
  updater.emit('update-downloaded', { version: '99.0.0' }); await manager.install();
  assert.equal(manager.installHandoff, false); assert.equal(service.cancelled, 1);
});

test('새 버전을 다운로드해도 재시작 전 현재 제품 버전은 유지한다', () => {
  const version = require('../../package.json').version;
  const { manager, updater } = setup({ version });
  updater.emit('update-available', { version: '99.0.0' });
  updater.emit('update-downloaded', { version: '99.0.0' });
  assert.equal(manager.snapshot().state, 'ready');
  assert.equal(manager.snapshot().targetVersion, '99.0.0');
  assert.equal(manager.snapshot().currentVersion, version);
});

test('무설치 압축 해제 준비 실패는 서버 종료 전에 차단하고 잠금을 돌려준다', async () => {
  const { manager, updater, service } = setup();
  updater.prepareInstall = async () => { throw new Error('invalid portable archive'); };
  updater.emit('update-downloaded', { version: '0.2.0' }); await manager.install();
  assert.equal(manager.snapshot().state, 'error'); assert.equal(service.stopped, 0);
  assert.equal(service.cancelled, 1); assert.equal(updater.installed, undefined);
});

test('무설치 준비·정상 종료 뒤 보조 프로세스 준비를 기다리고 실패를 처리한다', async () => {
  const events = [];
  const { manager, updater } = setup({prepare:async()=>events.push('lease'),stop:async()=>events.push('stop'),cancel:async()=>events.push('cancel')});
  updater.prepareInstall = async()=>events.push('extract');
  updater.quitAndInstall = async()=>{events.push('handoff');throw new Error('helper failed');};
  updater.emit('update-downloaded',{version:'0.2.0'}); await manager.install();
  assert.deepEqual(events,['lease','extract','stop','handoff','cancel']);
  assert.equal(manager.snapshot().state,'error');
});
test('다운로드 완료만으로 설치하거나 종료하지 않는다', async () => {
  const { manager, updater, service } = setup(); updater.emit('update-downloaded', { version: '0.2.0' });
  assert.equal(manager.snapshot().state, 'ready'); assert.equal(service.prepared, 0); assert.equal(updater.installed, undefined);
  assert.equal(updater.autoInstallOnAppQuit, false); assert.equal(updater.allowDowngrade, false); assert.equal(updater.allowPrerelease, false);
  await manager.install(); assert.equal(service.stopped, 1); assert.equal(updater.installed, true);
});
test('업무가 바쁘면 설치를 보류하고 사용자 재요청으로 설치한다', async () => {
  let busy = true;
  const { manager, updater, service } = setup({ prepare: async () => { if (busy) throw new Error('미답변 질문'); } });
  updater.emit('update-downloaded', { version: '0.2.0' });
  await manager.install(); assert.equal(manager.snapshot().state, 'waiting'); assert.equal(service.stopped, 0); assert.equal(updater.installed, undefined);
  busy = false; await manager.install(); assert.equal(service.stopped, 1);
});
test('종료·백업 실패 시 설치하지 않으며 중복 설치도 막는다', async () => {
  const { manager, updater, service } = setup({ stop: async () => { throw new Error('백업 실패'); } });
  updater.emit('update-downloaded', { version: '0.2.0' }); await manager.install();
  assert.equal(manager.snapshot().state, 'error'); assert.equal(updater.installed, undefined); assert.equal(service.cancelled, 1);
});
test('확인 실패를 최신으로 표시하지 않고 개발·미서명 빌드는 업데이트하지 않는다', async () => {
  const { manager, updater } = setup(); updater.checkForUpdates = async () => { throw new Error('offline'); };
  await manager.check(); assert.equal(manager.snapshot().state, 'error');
  const disabled = setup({ enabled: false }); await disabled.manager.check(); assert.equal(disabled.manager.snapshot().state, 'disabled');
});

test('시작과 4시간 주기 확인은 중지할 수 있고 수동 확인과 겹치지 않는다', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => t.mock.timers.reset());
  const { manager, updater } = setup();
  let calls = 0, finish;
  updater.checkForUpdates = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const dispose = startUpdateChecks(manager);
  assert.equal(calls, 1);
  // The provider may emit its terminal event before its promise settles.
  updater.emit('update-not-available');
  await manager.check();
  t.mock.timers.tick(4 * 60 * 60 * 1000);
  assert.equal(calls, 1);
  finish(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(4 * 60 * 60 * 1000);
  assert.equal(calls, 2);
  finish(); await Promise.resolve(); await Promise.resolve();
  dispose(); t.mock.timers.tick(4 * 60 * 60 * 1000);
  assert.equal(calls, 2);
});

test('오프라인과 호출 제한은 오류로 표시하고 다음 수동 확인에서 회복한다', async () => {
  for (const reason of ['offline', '429 rate limit']) {
    const { manager, updater } = setup();
    let attempts = 0;
    updater.checkForUpdates = async () => {
      attempts++;
      if (attempts === 1) throw new Error(reason);
      updater.emit('update-not-available');
    };
    await manager.check(); assert.equal(manager.snapshot().state, 'error');
    assert.equal(manager.snapshot().message.includes(reason), false);
    await manager.check(); assert.equal(manager.snapshot().state, 'current');
    assert.equal(attempts, 2);
  }
});

test('다운로드 진행률과 실패를 표시하고 재확인 후 다시 다운로드한다', async () => {
  const { manager, updater } = setup();
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '0.2.0' });
  await manager.check(); updater.emit('download-progress', { percent: 42.4 });
  assert.equal(manager.snapshot().state, 'downloading'); assert.equal(manager.snapshot().percent, 42);
  updater.emit('error', new Error('download checksum failed: secret URL'));
  assert.equal(manager.snapshot().state, 'error'); assert.equal(manager.downloaded, false);
  assert.equal(manager.snapshot().message.includes('secret'), false);
  await manager.install(); assert.equal(updater.installed, undefined);
  await manager.check(); assert.equal(manager.snapshot().state, 'downloading'); assert.equal(manager.snapshot().percent, 0);
  updater.emit('update-downloaded', { version: '0.2.0' });
  assert.equal(manager.snapshot().state, 'ready'); assert.equal(manager.snapshot().percent, 100);
});

test('자동 다운로드 Promise의 실패도 확인 요청에서 처리하고 재시도를 허용한다', async () => {
  const { manager, updater } = setup();
  const download = Promise.reject(new Error('connection reset during download'));
  download.catch(() => {}); // Keep the failing pre-fix assertion from creating unrelated test-runner noise.
  updater.checkForUpdates = async () => ({ downloadPromise: download });
  await manager.check();
  assert.equal(manager.snapshot().state, 'error');
  assert.equal(manager.checking, false);
  updater.checkForUpdates = async () => { updater.emit('update-not-available'); return {}; };
  await manager.check(); assert.equal(manager.snapshot().state, 'current');
});

test('설치 요청이 겹치거나 설치 전환 뒤 다시 와도 한 번만 종료·설치한다', async () => {
  let prepared;
  const { manager, updater, service } = setup({ prepare: () => new Promise(resolve => { prepared = resolve; }) });
  let installs = 0; updater.quitAndInstall = () => { installs++; };
  updater.emit('update-downloaded', { version: '0.2.0' });
  const first = manager.install(); await manager.install();
  prepared(); await first;
  const repeated = manager.install(); prepared(); await repeated;
  assert.equal(service.stopped, 1); assert.equal(installs, 1);
});
