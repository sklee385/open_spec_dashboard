const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ShutdownGuard } = require('../shutdown-guard.cjs');
const { UpdateManager } = require('../updates.cjs');

test('종료 준비는 한 요청만 소유하고 다른 요청은 해제할 수 없다', () => {
  const guard = new ShutdownGuard();
  const lease = guard.acquire();
  assert.equal(guard.active, true);
  assert.throws(() => guard.acquire(), /종료|설치/);
  guard.release(undefined); guard.release({});
  assert.equal(guard.owns(lease), true);
  assert.throws(() => guard.assertOwner({}), /종료|설치/);
  guard.release(lease); assert.equal(guard.owns(lease), false);
  assert.equal(guard.active, false);
  assert.doesNotThrow(() => guard.acquire());
});

function setup(guard, overrides = {}) {
  const updater = new EventEmitter(); updater.quitAndInstall = () => { updater.installs = (updater.installs || 0) + 1; };
  const operations = { stops: 0, cancels: 0 };
  const manager = new UpdateManager({ updater, enabled: true,
    prepare: async () => guard.acquire(),
    stop: async lease => { guard.assertOwner(lease); operations.stops++; },
    cancel: async lease => { guard.assertOwner(lease); guard.release(lease); operations.cancels++; },
    ...overrides,
  });
  updater.emit('update-downloaded', { version: '0.2.0' });
  return { manager, updater, operations };
}

test('앱 종료 준비 중 업데이트 요청은 기존 잠금을 유지하고 대기한다', async () => {
  const guard = new ShutdownGuard(), quitLease = guard.acquire();
  const { manager, updater, operations } = setup(guard);
  await manager.install();
  assert.equal(manager.snapshot().state, 'waiting');
  assert.equal(operations.stops, 0); assert.equal(operations.cancels, 0);
  assert.equal(guard.owns(quitLease), true); assert.equal(updater.installs, undefined);
  guard.release(quitLease); await manager.install();
  assert.equal(operations.stops, 1); assert.equal(updater.installs, 1);
});

test('설치의 종료·백업 실패는 자신이 획득한 잠금만 취소한다', async () => {
  const guard = new ShutdownGuard(); let failedLease;
  const { manager, updater, operations } = setup(guard, { stop: async lease => { guard.assertOwner(lease); failedLease = lease; throw new Error('backup failure'); } });
  await manager.install();
  assert.equal(manager.snapshot().state, 'error');
  assert.equal(operations.cancels, 1); assert.equal(guard.owns(failedLease), false);
  assert.equal(updater.installs, undefined);
  assert.doesNotThrow(() => guard.acquire());
});

test('업데이트가 준비를 기다리는 동안 앱 종료가 잠금을 얻지 못한다', async () => {
  const guard = new ShutdownGuard(); let ready;
  const { manager, updater, operations } = setup(guard, { prepare: async () => {
    const lease = guard.acquire(); await new Promise(resolve => { ready = resolve; }); return lease;
  } });
  const installing = manager.install();
  assert.throws(() => guard.acquire(), /종료|설치/);
  guard.release(undefined); assert.equal(guard.active, true);
  ready(); await installing;
  assert.equal(operations.stops, 1); assert.equal(updater.installs, 1);
});

test('서버가 잠근 뒤 준비 응답이 끊겨도 소유 요청이 취소해 업무를 재개한다', async () => {
  const guard = new ShutdownGuard(), gate = { locked: false, pending: 0 };
  let serverLocked = false; const calls = [];
  const api = async route => {
    calls.push(route);
    if (route === 'prepare') { serverLocked = true; throw new Error('response lost'); }
    if (route === 'cancel') serverLocked = false;
  };
  await assert.rejects(guard.prepare({ gate, probe: async () => {}, api }), /response lost/);
  assert.deepEqual(calls, ['prepare', 'cancel']);
  assert.equal(serverLocked, false); assert.equal(gate.locked, false); assert.equal(guard.active, false);
});

test('잠금 취소도 실패하면 요청 차단을 유지하고 명시적 재시도는 허용한다', async () => {
  const guard = new ShutdownGuard(), gate = { locked: false, pending: 0 };
  let failing = true;
  const context = { gate, probe: async () => {}, api: async () => { if (failing) throw new Error('offline'); } };
  await assert.rejects(guard.prepare(context), /offline/);
  assert.equal(gate.locked, true); assert.equal(guard.active, false);
  failing = false; const lease = await guard.prepare(context);
  await guard.cancel(lease, context);
  assert.equal(gate.locked, false); assert.equal(guard.active, false);
});

test('미저장 문서와 처리 중 요청은 서버 잠금 전에 차단한다', async () => {
  for (const pending of [0, 1]) {
    const guard = new ShutdownGuard(), gate = { locked: false, pending };
    let calls = 0;
    const probe = async () => { if (!pending) throw new Error('unsaved'); };
    await assert.rejects(guard.prepare({ gate, probe, api: async () => { calls++; } }));
    assert.equal(calls, 0); assert.equal(guard.active, false); assert.equal(gate.locked, false);
  }
});

test('다른 요청의 취소는 서버와 게이트웨이 잠금을 해제하지 않는다', async () => {
  const guard = new ShutdownGuard(), lease = guard.acquire();
  const gate = { locked: true, pending: 0 }; let calls = 0;
  await guard.cancel(undefined, { gate, api: async () => { calls++; } });
  await guard.cancel(Symbol('other'), { gate, api: async () => { calls++; } });
  assert.equal(gate.locked, true); assert.equal(guard.owns(lease), true); assert.equal(calls, 0);
});
