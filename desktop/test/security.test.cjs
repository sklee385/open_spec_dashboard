const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

async function launch(t, smoke = false, controls = {}) {
  const file = join(__dirname, '..', 'main.cjs'), localRequire = createRequire(file);
  const windows = [], handlers = new Map(), external = [], menus = [], dialogs = [], requests = [], files = [], spawns = [], owners = [], emergency = [], recoveryStates = [], journals = [];
  const app = new EventEmitter();
  app.commandLine = { appendSwitch() {} };
  app.setAsDefaultProtocolClient = () => controls.protocolFailure !== true;
  app.isDefaultProtocolClient = () => controls.protocolFailure !== true;
  Object.assign(app, { isPackaged: true, requestSingleInstanceLock: () => controls.duplicate !== true, getPath: () => '/isolated-profile', setPath() {}, exit(code) { app.exitCode = code; }, quit() { let blocked = false; app.emit('before-quit', { preventDefault() { blocked = true; } }); if (!blocked) { app.quitted = true; app.emit('will-quit'); } }, getVersion: () => '0.1.0', whenReady: () => ({ then(start) { const started = Promise.resolve().then(start); return { catch(recover) { app.completed = started.catch(recover); return app.completed; } }; } }) });
  const session = { webRequest: { onBeforeSendHeaders(filter, callback) { session.filter = filter; session.headers = callback; } }, setPermissionRequestHandler(callback) { session.permission = callback; } };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; windows.push(this);
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { id: windows.length, session, mainFrame: {}, getLastWebPreferences: () => options.webPreferences, setWindowOpenHandler(callback) { this.open = callback; }, executeJavaScript: async script => { if (smoke && !controls.smokeSuccess) throw new Error('isolated smoke failure'); if (script === 'window.desktopUpdates.status()') return { state: controls.personal ? 'idle' : 'disabled', currentVersion: '0.1.0' }; return controls.unsaved !== true; } });
      this.webContents.send = () => {};
    }
    async loadURL(url) { this.url = url; this.webContents.mainFrame.url = url; if (controls.loadFailure) throw Error('fixture page load failure'); }
    async loadFile(file) { this.url = pathToFileURL(file).href; this.webContents.mainFrame.url = this.url; }
    show() { this.visible = true; } hide() { this.visible = false; } focus() { this.focused = true; } isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; }
    isVisible() { return !!this.visible; }
    isMinimized() { return !!this.minimized; }
    restore() { this.minimized = false; this.restored = true; }
    close() { this.closeCount = (this.closeCount || 0) + 1; this.emit('close', { preventDefault() {} }); }
  }
  let tray;
  class Tray extends EventEmitter { constructor() { super(); tray = this; } setToolTip(text) { this.tooltip = text; } setContextMenu(menu) { menus.push(menu); } }
  const updater = new EventEmitter(); updater.isUpdateSupported = () => true;
  updater.setFeedURL = value => { updater.feed = value; };
  updater.checkForUpdates = async () => {};
  updater.quitAndInstall = async () => { updater.installed = (updater.installed || 0) + 1; };
  const gateway = new EventEmitter();
  Object.assign(gateway, { listen(_port, _host, done) { if (controls.gatewayFailure) { gateway.emit('error', new Error('fixture gateway failure')); return; } gateway.listening = true; done(); }, address: () => ({ port: 15001 }), closeAllConnections() {}, close(done) { gateway.listening = false; done?.(); } });
  let child;
  const electron = { app, BrowserWindow: Window, Tray, nativeImage: { createFromDataURL: () => ({}) }, Menu: { buildFromTemplate: menu => menu, setApplicationMenu() {} }, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) }, shell: { openExternal: async url => { external.push(url); } }, dialog: { async showMessageBox(value, options) { const selected = options || value; dialogs.push(selected); return { response: typeof controls.dialogResponse === 'function' ? controls.dialogResponse(selected) : controls.dialogResponse ?? 1 }; } } };
  const requireMock = id => {
    if (id === './drafts.cjs') return { DraftStore: class {}, registerDraftBridge: () => () => {} };
    if (id === './recovery-state.cjs') return {
      RecoveryState: class { constructor(directory) { this.directory = directory; this.safeStartup = controls.unclean === true; this.safeMode = controls.savedSafeMode === true; this.startedCount = 0; this.stoppedCount = 0; recoveryStates.push(this); } started() { this.startedCount++; } stopped() { this.stoppedCount++; } setSafeMode(enabled) { this.safeMode = enabled; } },
      HealthJournal: class { constructor(directory) { this.directory = directory; this.events = []; journals.push(this); } record(type, details) { this.events.push({ type, ...details }); } list() { return this.events.map(value => ({ ...value })); } },
    };
    if (id === './emergency.cjs') return {
      async captureOwner(options) { owners.push(options); if (controls.ownerFailure) throw Error('fixture owner missing'); return { ownerPath: '/isolated-profile/process-owner.json', nonce: 'fixture-owner-nonce' }; },
      async launchEmergency(options) { emergency.push(options); if (controls.forceFailure) throw Error('fixture emergency launch failure'); },
    };
    if (id === './portable-updater.cjs') return { PortableUpdater: class { constructor(options) { updater.portable = true; updater.installConfig = options; return updater; } } };
    if (id === 'electron') return electron;
    if (id === 'node:fs') return { mkdirSync() {}, appendFileSync() {}, writeFileSync(file, data) { files.push({ file, data }); }, readdirSync: () => [] };
    if (id === 'node:child_process') return { spawn(binary, args, options) { spawns.push({ binary, args, options }); child = new EventEmitter(); child.pid = 4442; child.stderr = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.send = () => { const finish = () => { child.emit('message', { type: 'stopped' }); child.exitCode = 0; child.emit('exit', 0); }; if (controls.deferShutdown) controls.finishShutdown = finish; else finish(); }; queueMicrotask(() => { controls.beforeReady?.({ owners, child }); child.emit('message', { type: 'ready', port: 15002 }); }); return child; } };
    if (id.endsWith(join('backend', 'dist', 'gateway.js'))) return { createGateway: () => gateway };
    if (id.endsWith(join('node_modules', 'electron-updater'))) return { autoUpdater: updater };
    if (id.endsWith('release-policy.json')) return controls.portable ? { mode: 'portable-github', repository: 'sklee385/open_spec_dashboard', updatesEnabled: true } : controls.personal ? { mode: 'personal-github', repository: 'sklee385/open_spec_dashboard', updatesEnabled: true } : { signedRelease: false };
    return localRequire(id);
  };
  vm.runInNewContext(readFileSync(file, 'utf8'), { require: requireMock, __dirname: join(__dirname, '..'), process: { pid: 4441, execPath: 'C:/isolated-app/OpenSpecBoard.exe', argv: smoke ? ['--desktop-smoke-test', ...(controls.lifecycle ? ['--desktop-lifecycle-test'] : []), ...(controls.personalTest ? ['--desktop-personal-update-test'] : [])] : [], env: { DESKTOP_SMOKE_DIRECTORY: '/isolated-profile', ...(controls.safeEnvironment ? { OPENSPEC_SAFE_MODE: '1' } : {}) }, resourcesPath: '/isolated-resources', platform: 'win32', arch: 'x64' }, console: { ...console, log() {}, error() {} }, URL, AbortSignal, fetch: async url => { requests.push(url); if (controls.serverFailure && url.endsWith('/diagnostics')) throw Error('fixture backend unavailable'); const busy = controls.busy && url.endsWith('/prepare'); return { ok: !busy, status: busy ? 409 : 200, json: async () => ({ idle: !busy, sources: [], safeMode: recoveryStates[0]?.safeMode, works: [], history: [], blockers: busy ? [{ workId: 'busy-work', reasons: ['질문 응답 대기'] }] : [] }) }; }, setTimeout, clearTimeout, queueMicrotask }, { filename: file });
  await app.completed;
  t.after(() => app.emit('will-quit'));
  if (!smoke && menus.length) menus[0].find(item => item.label === '앱 업데이트').click();
  return { windows, handlers, session, external, app, child, gateway, tray, menus, dialogs, requests, files, updater, spawns, owners, emergency, recoveryStates, journals };
}

test('두 창의 렌더러 격리와 앱 권한 거절을 유지한다', async t => {
  const { windows, session } = await launch(t);
  for (const [index, window] of windows.entries()) assert.deepEqual(JSON.parse(JSON.stringify(window.options.webPreferences)), {
    preload: join(__dirname, '..', index === 0 ? 'dashboard-preload.cjs' : 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
  });
  let allowed; session.permission({}, 'media', value => { allowed = value; }); assert.equal(allowed, false);
});

test('인증 헤더는 앱 출처와 소유 창 요청으로만 한정한다', async t => {
  const { windows, session } = await launch(t);
  assert.deepEqual(Array.from(session.filter.urls), [new URL(windows[0].url).origin + '/*']);
  let result;
  session.headers({ webContentsId: windows[0].webContents.id, requestHeaders: {} }, value => { result = value; });
  assert.match(result.requestHeaders['x-desktop-token'], /^[a-f0-9]{64}$/);
  session.headers({ webContentsId: windows[1].webContents.id, requestHeaders: {} }, value => { result = value; });
  assert.equal(result.cancel, true); assert.equal(result.requestHeaders, undefined);
});

test('업데이트 IPC는 소유 창의 정확한 메인 프레임만 허용한다', async t => {
  const { windows, handlers } = await launch(t), update = windows[1];
  update.webContents.mainFrame.url = update.url;
  const handler = handlers.get('desktop:status');
  assert.equal(handler({ sender: update.webContents, senderFrame: update.webContents.mainFrame }).state, 'disabled');
  for (const event of [
    { sender: windows[0].webContents, senderFrame: { url: update.url } },
    { sender: update.webContents, senderFrame: { url: 'https://example.com' } },
    { sender: update.webContents, senderFrame: null },
    { sender: update.webContents, senderFrame: { url: update.url } },
  ]) assert.throws(() => handler(event), /허용/);
  assert.deepEqual([...handlers.keys()].sort(), ['desktop:attention-ready', 'desktop:check', 'desktop:health-force', 'desktop:health-inspect', 'desktop:health-interrupt', 'desktop:health-open-work', 'desktop:health-recover', 'desktop:health-safe-mode', 'desktop:install', 'desktop:status']);
});
test('프로그램 알림은 소유 대시보드 준비 후 기존 창으로 전달하고 다른 프레임을 거부한다', async t => {
  const { windows, handlers, app } = await launch(t), dashboard = windows[0], update = windows[1], received = [];
  dashboard.webContents.send = (channel, value) => received.push({ channel, value }); dashboard.hide(); dashboard.minimized = true;
  app.emit('second-instance', {}, ['app.exe', 'openspecboard://attention?workId=w&questionId=q']);
  assert.equal(dashboard.restored, true); assert.equal(dashboard.visible, true); assert.equal(windows.length, 2); assert.equal(received.length, 0);
  const ready = handlers.get('desktop:attention-ready');
  assert.throws(() => ready({ sender: update.webContents, senderFrame: update.webContents.mainFrame }), /허용/);
  assert.throws(() => ready({ sender: dashboard.webContents, senderFrame: { url: dashboard.url } }), /허용/);
  assert.equal(ready({ sender: dashboard.webContents, senderFrame: dashboard.webContents.mainFrame }), true);
  assert.deepEqual(received, [{ channel: 'desktop:attention', value: { workId: 'w', questionId: 'q' } }]);
  app.emit('second-instance', {}, ['app.exe', 'openspecboard://invalid']); assert.deepEqual(received.at(-1).value, { invalid: true });
});

test('외부 탐색과 팝업은 차단하고 허용 HTTP 링크만 시스템 브라우저로 전달한다', async t => {
  const { windows, external } = await launch(t), contents = windows[0].webContents;
  for (const url of ['file:///C:/private.txt', 'javascript:alert(1)', 'data:text/html,test', 'cmd:calc', 'https://user:pass@example.com']) {
    let blocked = false;
    contents.emit('will-navigate', { preventDefault() { blocked = true; } }, url);
    assert.equal(blocked, true); assert.equal(contents.open({ url }).action, 'deny');
  }
  assert.equal(external.length, 0);
  let blocked = false;
  contents.emit('will-navigate', { preventDefault() { blocked = true; } }, windows[0].url + '/work');
  assert.equal(blocked, false);
  assert.equal(contents.open({ url: 'https://example.com/help' }).action, 'deny');
  assert.deepEqual(external, ['https://example.com/help']);
  assert.equal(windows[1].webContents.open({ url: 'https://example.com' }).action, 'deny');
});

test('preload는 세 고정 IPC만 노출하고 임의 입력을 전달하지 않는다', () => {
  let api; const calls = [];
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'preload.cjs'), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'desktopUpdates'); api = value; } }, ipcRenderer: { invoke: (...args) => calls.push(args) } }) });
  assert.deepEqual(Object.keys(api).sort(), ['check', 'install', 'status']);
  api.status('arbitrary'); api.check('arbitrary'); api.install('arbitrary');
  assert.deepEqual(calls, [['desktop:status'], ['desktop:check'], ['desktop:install']]);
});

test('격리 smoke 검증 실패는 실패 코드를 유지하면서 유휴 소유 자식을 정상 종료한다', async t => {
  const { app, child, gateway, files } = await launch(t, true);
  assert.equal(app.exitCode, 1); assert.equal(child.exitCode, 0); assert.equal(gateway.listening, false);
  assert.equal(JSON.parse(files.find(item => item.file.endsWith('notifications.json')).data).enabled, false);
});

test('창 닫기는 서비스를 유지하고 트레이와 중복 실행은 기존 창을 다시 연다', async t => {
  const { windows, app, child, tray, menus, requests } = await launch(t);
  const window = windows[0]; let blocked = false;
  window.emit('close', { preventDefault() { blocked = true; } });
  assert.equal(blocked, true); assert.equal(window.visible, false); assert.equal(child.exitCode, null);
  assert.equal(requests.length, 0); assert.match(tray.tooltip, /업무를 유지/);
  tray.emit('double-click'); assert.equal(window.visible, true);
  window.hide(); menus[0].find(item => item.label === 'OpenSpecBoard 열기').click(); assert.equal(window.visible, true);
  window.hide(); app.emit('second-instance'); assert.equal(window.visible, true); assert.equal(window.focused, true);
});

test('중복 앱은 창과 자식을 생성하지 않고 종료한다', async t => {
  const { app, child, windows } = await launch(t, false, { duplicate: true });
  assert.equal(app.exitCode, 0); assert.equal(child, undefined); assert.equal(windows.length, 0);
});

const drain = async () => { await new Promise(resolve => setImmediate(resolve)); };

test('서비스 ready 이전에 실행 소유자를 기록하기 시작한다', async t => {
  let capturedBeforeReady = false;
  await launch(t, false, { beforeReady: ({ owners }) => { capturedBeforeReady = owners.length === 1; } });
  assert.equal(capturedBeforeReady, true);
});

test('강제 종료 요청 뒤 업데이트 설치는 서버 종료 전에 거절한다', async t => {
  const f = await launch(t, false, { personal: true, dialogResponse: 1 });
  f.updater.emit('update-downloaded', { version: '99.0.0' });
  f.menus[0].find(item => item.label === '강제 종료…').click(); await drain();
  const update = f.windows[1];
  const result = await f.handlers.get('desktop:install')({ sender: update.webContents, senderFrame: update.webContents.mainFrame });
  assert.equal(result.state, 'waiting');
  assert.equal(f.requests.some(url => url.endsWith('/prepare')), false);
  assert.equal(f.child.exitCode, null); assert.equal(f.updater.installed, undefined);
  assert.equal(f.emergency.length, 1);
});

test('업데이트 정상 종료 진행 중 강제 종료는 설치 인계를 차단한다', async t => {
  const controls = { personal: true, dialogResponse: 1, deferShutdown: true };
  const f = await launch(t, false, controls);
  f.updater.emit('update-downloaded', { version: '99.0.0' });
  const update = f.windows[1];
  const installing = f.handlers.get('desktop:install')({ sender: update.webContents, senderFrame: update.webContents.mainFrame });
  await drain(); assert.equal(typeof controls.finishShutdown, 'function');
  f.menus[0].find(item => item.label === '강제 종료…').click(); await drain();
  controls.finishShutdown();
  assert.equal((await installing).state, 'error');
  assert.equal(f.emergency.length, 1); assert.equal(f.updater.installed, undefined);
  assert.equal(f.recoveryStates[0].stoppedCount, 0);
});

test('업데이트 인계가 완료되면 강제 종료 도구를 시작하지 않는다', async t => {
  const f = await launch(t, false, { personal: true, dialogResponse: 1 });
  f.updater.emit('update-downloaded', { version: '99.0.0' });
  const update = f.windows[1];
  await f.handlers.get('desktop:install')({ sender: update.webContents, senderFrame: update.webContents.mainFrame });
  assert.equal(f.updater.installed, 1);
  f.menus[0].find(item => item.label === '강제 종료…').click(); await drain();
  assert.equal(f.emergency.length, 0);
  assert.match(f.dialogs.at(-1).message, /인계/);
});

test('무설치 main은 ZIP 업데이트 공급자를 사용하고 설치형 피드를 구성하지 않는다', async t => {
  const { updater, handlers, windows } = await launch(t,false,{portable:true});
  assert.equal(updater.portable,true); assert.equal(updater.feed,undefined);
  assert.equal(typeof updater.installConfig.prepareInstall,'function');
  assert.equal(updater.autoInstallOnAppQuit,false);
  const target=windows[1];target.webContents.mainFrame.url=target.url;
  assert.equal(handlers.get('desktop:status')({sender:target.webContents,senderFrame:target.webContents.mainFrame}).state,'checking');
});

test('개인용 패키지는 실제 main의 IPC에서 업데이트를 활성화하고 지정 GitHub 피드를 사용한다', async t => {
  const { windows, handlers, updater } = await launch(t, false, { personal: true });
  const update = windows[1]; update.webContents.mainFrame.url = update.url;
  assert.equal(handlers.get('desktop:status')({ sender: update.webContents, senderFrame: update.webContents.mainFrame }).state, 'checking');
  assert.deepEqual(JSON.parse(JSON.stringify(updater.feed)), { provider: 'github', owner: 'sklee385', repo: 'open_spec_dashboard' });
  assert.equal(updater.autoInstallOnAppQuit, false);
});
test('진행 중 업무의 명시적 종료는 보류하고 유휴 재시도에서만 소유 자식을 종료한다', async t => {
  const controls = { busy: true, dialogResponse: 2 };
  const { app, child, menus, dialogs, requests } = await launch(t, false, controls);
  const quit = menus[0].find(item => item.label === '앱 종료').click;
  quit(); await drain();
  assert.equal(child.exitCode, null); assert.equal(app.quitted, undefined);
  assert.match(dialogs[0].message, /종료를 보류/); assert.match(dialogs[0].detail, /전체 상태 점검/);
  assert.equal(requests.filter(url => url.endsWith('/cancel')).length, 1);
  controls.busy = false; quit(); await drain();
  assert.equal(child.exitCode, 0); assert.equal(app.quitted, true);
});

test('미저장 화면은 서버 준비 요청 전에 종료를 보류한다', async t => {
  const { child, menus, dialogs, requests } = await launch(t, false, { unsaved: true, dialogResponse: 2 });
  menus[0].find(item => item.label === '앱 종료').click(); await drain();
  assert.equal(child.exitCode, null); assert.equal(requests.length, 0); assert.match(dialogs[0].detail, /미저장/);
});

test('게이트웨이 시작 실패는 준비된 소유 자식만 정상 종료하고 재시도 선택을 제공한다', async t => {
  const { app, child, windows, dialogs, requests } = await launch(t, false, { gatewayFailure: true });
  assert.equal(child.exitCode, 0); assert.equal(windows.length, 0); assert.equal(app.quitted, true);
  assert.deepEqual(Array.from(dialogs[0].buttons), ['다시 시도', '앱 종료']);
  assert.equal(requests.filter(url => url.endsWith('/prepare')).length, 1);
});

test('기본 숨김 smoke는 창 재표시를 요구하지 않고 정상 종료한다', async t => {
  const { app, windows, child } = await launch(t, true, { smokeSuccess: true });
  assert.equal(windows[0].closeCount || 0, 0); assert.equal(app.quitted, true); assert.equal(child.exitCode, 0);
});

test('명시적 lifecycle smoke에서만 창 닫기와 트레이 재표시를 검사한다', async t => {
  const { app, windows } = await launch(t, true, { smokeSuccess: true, lifecycle: true });
  assert.equal(windows[0].closeCount, 1); assert.equal(app.quitted, true);
});

test('개인용 배포 검사는 업데이트가 비활성이면 실패하고 소유 자식은 정상 종료한다', async t => {
  const { app, child } = await launch(t, true, { smokeSuccess: true, personalTest: true });
  assert.equal(app.exitCode, 1); assert.equal(child.exitCode, 0);
});

test('업데이트가 활성화된 개인용 배포 검사는 정상 종료한다', async t => {
  const { app, child } = await launch(t, true, { smokeSuccess: true, personalTest: true, personal: true });
  assert.equal(app.quitted, true); assert.equal(child.exitCode, 0);
});

test('최초 화면 로드 실패는 서버를 종료하지 않고 네이티브 화면 복구를 안내한다', async t => {
  const { child, app, dialogs, requests } = await launch(t, false, { loadFailure: true });
  assert.equal(child.exitCode, null); assert.equal(app.quitted, undefined);
  assert.equal(dialogs.length, 1); assert.equal(dialogs[0].title, 'OpenSpecBoard 화면 복구');
  assert.equal(requests.filter(url => url.endsWith('/prepare')).length, 0);
});

test('실행 중 화면 충돌과 수동 복구는 같은 서버를 유지하며 종료 중 복구는 열지 않는다', async t => {
  const { windows, child, dialogs, menus } = await launch(t);
  windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  windows[0].emit('unresponsive');
  await new Promise(setImmediate);
  assert.equal(dialogs.length, 1); assert.equal(child.exitCode, null);
  menus[0].find(item => item.label === '화면 복구').click();
  await new Promise(setImmediate);
  assert.equal(dialogs.length, 2); assert.equal(child.exitCode, null);
});

for (const controls of [{ unclean: true }, { savedSafeMode: true }, { safeEnvironment: true }]) {
  test(`비정상·안전 시작은 소유 서비스에만 안전 모드를 전달한다 ${JSON.stringify(controls)}`, async t => {
    const { spawns, windows, recoveryStates, journals, files, owners } = await launch(t, false, controls);
    assert.equal(spawns.length, 1); assert.equal(spawns[0].options.env.OPENSPEC_SAFE_MODE, '1');
    assert.equal(spawns[0].options.cwd, '/isolated-profile'); assert.equal(spawns[0].options.windowsHide, true);
    assert.equal(recoveryStates[0].startedCount, 1); assert.equal(recoveryStates[0].stoppedCount, 0);
    assert.equal(journals[0].events.some(event => event.type === 'app-started' && event.state === 'safe'), true);
    assert.equal(windows.some(window => window.options.title === 'OpenSpecBoard 상태 점검'), true);
    assert.deepEqual(owners.map(owner => ({ pid: owner.pid, childPid: owner.childPid })), [{ pid: 4441, childPid: 4442 }]);
    assert.equal(files.some(value => /recovery-state|recovery-events|process-owner/.test(value.file)), false);
  });
}

test('정상 시작은 안전 모드를 끄고 정상 종료 상태는 메모리 복구 기록에만 남긴다', async t => {
  const { spawns, recoveryStates, menus, files } = await launch(t);
  assert.equal(spawns[0].options.env.OPENSPEC_SAFE_MODE, '0');
  menus[0].find(item => item.label === '앱 종료').click(); await drain();
  assert.equal(recoveryStates[0].stoppedCount, 1);
  assert.equal(files.some(value => /recovery-state|recovery-events/.test(value.file)), false);
});

test('네이티브 강제 종료 취소는 소유 프로세스와 업데이트를 그대로 유지한다', async t => {
  const { menus, dialogs, emergency, child, recoveryStates, updater, app } = await launch(t, false, { dialogResponse: 2 });
  menus[0].find(item => item.label === '강제 종료…').click(); await drain();
  assert.match(dialogs[0].title, /강제 종료/); assert.match(dialogs[0].detail, /미저장 입력/);
  assert.equal(emergency.length, 0); assert.equal(child.exitCode, null); assert.equal(app.quitted, undefined);
  assert.equal(recoveryStates[0].safeMode, false); assert.equal(updater.autoInstallOnAppQuit, false);
});

test('네이티브 강제 종료 확인은 검증된 소유 레코드만 긴급 도구로 전달한다', async t => {
  const { menus, emergency, child, recoveryStates, journals, requests, app } = await launch(t, false, { dialogResponse: 1 });
  menus[0].find(item => item.label === '강제 종료…').click(); await drain();
  assert.equal(emergency.length, 1);
  assert.equal(emergency[0].ownerPath, '/isolated-profile/process-owner.json'); assert.equal(emergency[0].confirm, true); assert.equal(emergency[0].expectedNonce, 'fixture-owner-nonce');
  assert.equal(recoveryStates[0].safeMode, true); assert.equal(recoveryStates[0].stoppedCount, 0);
  assert.equal(journals[0].events.some(event => event.type === 'force-exit-requested'), true);
  assert.equal(requests.length, 0); assert.equal(child.exitCode, null); assert.equal(app.quitted, undefined);
});

test('강제 종료 화면의 정상 종료 먼저 시도는 긴급 도구 없이 정상 종료 경로를 사용한다', async t => {
  const { menus, emergency, child, recoveryStates, app, requests } = await launch(t, false, { dialogResponse: 0 });
  menus[0].find(item => item.label === '강제 종료…').click(); await drain();
  assert.equal(emergency.length, 0); assert.equal(child.exitCode, 0); assert.equal(app.quitted, true);
  assert.equal(recoveryStates[0].stoppedCount, 1); assert.equal(requests.some(url => url.endsWith('/prepare')), true);
});

test('종료 보류 후 강제 종료는 별도 네이티브 확인을 다시 받는다', async t => {
  const { menus, dialogs, emergency, requests } = await launch(t, false, { busy: true, dialogResponse: value => value.message === '앱 종료를 보류했습니다.' ? 1 : 0 });
  menus[0].find(item => item.label === '앱 종료').click(); await drain();
  assert.equal(dialogs.length, 2); assert.deepEqual(Array.from(dialogs[1].buttons), ['강제 종료', '취소']);
  assert.equal(emergency.length, 1); assert.equal(requests.filter(url => url.endsWith('/cancel')).length, 1);
});

test('소유 레코드가 없으면 강제 종료 도구를 실행하지 않는다', async t => {
  const { menus, dialogs, emergency, child, journals } = await launch(t, false, { ownerFailure: true, dialogResponse: 1 });
  menus[0].find(item => item.label === '강제 종료…').click(); await drain();
  assert.equal(emergency.length, 0); assert.equal(child.exitCode, null);
  assert.match(dialogs[0].message, /소유권을 확인하지 못했습니다/);
  assert.equal(journals[0].events.some(event => event.type === 'owner-unavailable'), true);
});

test('긴급 도구 실행 실패는 정상 종료 성공으로 표시하지 않는다', async t => {
  const { menus, dialogs, emergency, app, child, recoveryStates } = await launch(t, false, { forceFailure: true, dialogResponse: 1 });
  menus[0].find(item => item.label === '강제 종료…').click(); await drain();
  assert.equal(emergency.length, 1); assert.match(dialogs.at(-1).message, /강제 종료를 확인하지 못했습니다/);
  assert.equal(app.quitted, undefined); assert.equal(child.exitCode, null); assert.equal(recoveryStates[0].safeMode, true); assert.equal(recoveryStates[0].stoppedCount, 0);
});

test('백엔드가 응답하지 않아도 별도 진단 창과 소유 프레임 점검을 유지한다', async t => {
  const { menus, windows, handlers, child, requests } = await launch(t, false, { serverFailure: true });
  menus[0].find(item => item.label === '전체 상태 점검').click(); await drain();
  const health = windows.find(window => window.options.title === 'OpenSpecBoard 상태 점검');
  assert.equal(health.visible, true); assert.equal(health.options.webPreferences.sandbox, true);
  assert.equal(health.webContents.open({ url: 'https://evil.example/' }).action, 'deny');
  const event = { sender: health.webContents, senderFrame: health.webContents.mainFrame };
  const result = await handlers.get('desktop:health-inspect')(event);
  assert.equal(result.server, null); assert.equal(result.error.code, 'connection'); assert.equal(result.desktop.ownerVerified, true);
  assert.equal(child.exitCode, null); assert.equal(requests.some(url => url.endsWith('/prepare')), false);
  for (const channel of ['inspect', 'recover', 'interrupt', 'open-work', 'safe-mode', 'force']) {
    const handler = handlers.get(`desktop:health-${channel}`);
    await assert.rejects(handler({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame }, 'w'), /허용/);
    await assert.rejects(handler({ sender: health.webContents, senderFrame: { url: health.url } }, 'w'), /허용/);
  }
});

test('진단 창의 업무 이동은 검증한 식별자만 기존 대시보드로 전달한다', async t => {
  const { menus, windows, handlers } = await launch(t);
  menus[0].find(item => item.label === '전체 상태 점검').click(); await drain();
  const dashboard = windows[0], health = windows.find(window => window.options.title === 'OpenSpecBoard 상태 점검'), sent = [];
  dashboard.webContents.send = (...args) => sent.push(args); dashboard.hide(); dashboard.minimized = true;
  const event = { sender: health.webContents, senderFrame: health.webContents.mainFrame }, handler = handlers.get('desktop:health-open-work');
  await handler(event, 'work_1-A');
  assert.deepEqual(sent, [['desktop:open-work', 'work_1-A']]); assert.equal(dashboard.visible, true); assert.equal(dashboard.restored, true);
  for (const id of ['../work', '', { workId: 'w' }, 'w\n', 'a'.repeat(151)]) await assert.rejects(handler(event, id), /식별자/);
  assert.equal(sent.length, 1);
});
