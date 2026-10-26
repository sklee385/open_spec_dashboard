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
  const windows = [], handlers = new Map(), external = [], menus = [], dialogs = [], requests = [], files = [];
  const app = new EventEmitter();
  app.setAsDefaultProtocolClient = () => controls.protocolFailure !== true;
  app.isDefaultProtocolClient = () => controls.protocolFailure !== true;
  Object.assign(app, { isPackaged: true, requestSingleInstanceLock: () => controls.duplicate !== true, getPath: () => '/isolated-profile', setPath() {}, exit(code) { app.exitCode = code; }, quit() { let blocked = false; app.emit('before-quit', { preventDefault() { blocked = true; } }); if (!blocked) { app.quitted = true; app.emit('will-quit'); } }, getVersion: () => '0.1.0', whenReady: () => ({ then(start) { const started = Promise.resolve().then(start); return { catch(recover) { app.completed = started.catch(recover); return app.completed; } }; } }) });
  const session = { webRequest: { onBeforeSendHeaders(filter, callback) { session.filter = filter; session.headers = callback; } }, setPermissionRequestHandler(callback) { session.permission = callback; } };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; windows.push(this);
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { id: windows.length, session, mainFrame: {}, getLastWebPreferences: () => options.webPreferences, setWindowOpenHandler(callback) { this.open = callback; }, executeJavaScript: async script => { if (smoke && !controls.smokeSuccess) throw new Error('isolated smoke failure'); if (script === 'window.desktopUpdates.status()') return { state: controls.personal ? 'idle' : 'disabled', currentVersion: '0.1.0' }; return controls.unsaved !== true; } });
    }
    async loadURL(url) { this.url = url; this.webContents.mainFrame.url = url; }
    async loadFile(file) { this.url = pathToFileURL(file).href; }
    show() { this.visible = true; } hide() { this.visible = false; } focus() { this.focused = true; } isDestroyed() { return false; }
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
  const gateway = new EventEmitter();
  Object.assign(gateway, { listen(_port, _host, done) { if (controls.gatewayFailure) { gateway.emit('error', new Error('fixture gateway failure')); return; } gateway.listening = true; done(); }, address: () => ({ port: 15001 }), closeAllConnections() {}, close(done) { gateway.listening = false; done?.(); } });
  let child;
  const electron = { app, BrowserWindow: Window, Tray, nativeImage: { createFromDataURL: () => ({}) }, Menu: { buildFromTemplate: menu => menu, setApplicationMenu() {} }, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, shell: { openExternal: async url => { external.push(url); } }, dialog: { async showMessageBox(value) { dialogs.push(value); return { response: 1 }; } } };
  const requireMock = id => {
    if (id === './portable-updater.cjs') return { PortableUpdater: class { constructor(options) { updater.portable = true; updater.installConfig = options; return updater; } } };
    if (id === 'electron') return electron;
    if (id === 'node:fs') return { mkdirSync() {}, appendFileSync() {}, writeFileSync(file, data) { files.push({ file, data }); }, readdirSync: () => [] };
    if (id === 'node:child_process') return { spawn() { child = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.send = () => { child.emit('message', { type: 'stopped' }); child.exitCode = 0; child.emit('exit', 0); }; queueMicrotask(() => child.emit('message', { type: 'ready', port: 15002 })); return child; } };
    if (id.endsWith(join('backend', 'dist', 'gateway.js'))) return { createGateway: () => gateway };
    if (id.endsWith(join('node_modules', 'electron-updater'))) return { autoUpdater: updater };
    if (id.endsWith('release-policy.json')) return controls.portable ? { mode: 'portable-github', repository: 'sklee385/open_spec_dashboard', updatesEnabled: true } : controls.personal ? { mode: 'personal-github', repository: 'sklee385/open_spec_dashboard', updatesEnabled: true } : { signedRelease: false };
    return localRequire(id);
  };
  vm.runInNewContext(readFileSync(file, 'utf8'), { require: requireMock, __dirname: join(__dirname, '..'), process: { argv: smoke ? ['--desktop-smoke-test', ...(controls.lifecycle ? ['--desktop-lifecycle-test'] : []), ...(controls.personalTest ? ['--desktop-personal-update-test'] : [])] : [], env: { DESKTOP_SMOKE_DIRECTORY: '/isolated-profile' }, resourcesPath: '/isolated-resources', platform: 'win32', arch: 'x64' }, console: { ...console, log() {}, error() {} }, URL, AbortSignal, fetch: async url => { requests.push(url); return { ok: !controls.busy || !url.endsWith('/prepare'), json: async () => ({ idle: true, sources: [] }) }; }, setTimeout, clearTimeout, queueMicrotask }, { filename: file });
  await app.completed;
  t.after(() => app.emit('will-quit'));
  if (!smoke && menus.length) menus[0].find(item => item.label === '앱 업데이트').click();
  return { windows, handlers, session, external, app, child, gateway, tray, menus, dialogs, requests, files, updater };
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
  assert.deepEqual([...handlers.keys()].sort(), ['desktop:attention-ready', 'desktop:check', 'desktop:install', 'desktop:status']);
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
  const controls = { busy: true };
  const { app, child, menus, dialogs, requests } = await launch(t, false, controls);
  const quit = menus[0].find(item => item.label === '앱 종료').click;
  quit(); await drain();
  assert.equal(child.exitCode, null); assert.equal(app.quitted, undefined);
  assert.match(dialogs[0].message, /종료를 보류/); assert.match(dialogs[0].detail, /질문·승인/);
  assert.equal(requests.filter(url => url.endsWith('/cancel')).length, 1);
  controls.busy = false; quit(); await drain();
  assert.equal(child.exitCode, 0); assert.equal(app.quitted, true);
});

test('미저장 화면은 서버 준비 요청 전에 종료를 보류한다', async t => {
  const { child, menus, dialogs, requests } = await launch(t, false, { unsaved: true });
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
