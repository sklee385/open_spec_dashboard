const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { join, dirname } = require('node:path');
const { mkdirSync, appendFileSync, readdirSync, writeFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { UpdateManager, startUpdateChecks } = require('./updates.cjs');
const { configureUpdateSelection } = require('./update-selection.cjs');
const { allowPersonalUpdates } = require('./update-policy.cjs');
const { assertRendererClosable } = require('./renderer-close.cjs');
const { ShutdownGuard } = require('./shutdown-guard.cjs');
const shutdownGuard = new ShutdownGuard();
const { AttentionRouter, registerAttentionProtocol, trustedAttentionSender } = require('./attention-links.cjs');

let window, updateWindow, tray, child, gateway, manager, origin;
function showDashboard() { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
const attentionRouter = new AttentionRouter({ send: target => window.webContents.send('desktop:attention', target), show: showDashboard });
attentionRouter.accept(process.argv);
let startupPhase = 'initialization';
let smokeServiceDiagnostics = '';
const smoke = process.argv.includes('--desktop-smoke-test');
if (smoke) {
  if (!process.env.DESKTOP_SMOKE_DIRECTORY) throw new Error('격리한 smoke 데이터 경로가 필요합니다');
  mkdirSync(process.env.DESKTOP_SMOKE_DIRECTORY, { recursive: true });
  if (readdirSync(process.env.DESKTOP_SMOKE_DIRECTORY).length) throw new Error('smoke에는 비어 있는 새 프로필 경로가 필요합니다');
  app.setPath('userData', process.env.DESKTOP_SMOKE_DIRECTORY);
}
let allowQuit = false, stopping = false, shutdownRequested = false;
const gate = { locked: false, pending: 0 };
const token = randomBytes(32).toString('hex');
const userDirectory = app.getPath('userData');
const serviceDirectory = app.isPackaged ? join(process.resourcesPath, 'service') : join(__dirname, '..', 'service');
const nodeDirectory = join(serviceDirectory, 'runtime');
const nodeBinary = join(nodeDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
const dataDirectory = join(userDirectory, 'data');
const configPath = join(userDirectory, 'config.json');
const updateURL = pathToFileURL(join(__dirname, 'updates.html')).href;
const log = message => { mkdirSync(join(userDirectory, 'logs'), { recursive: true }); appendFileSync(join(userDirectory, 'logs', 'desktop.log'), `${new Date().toISOString()} ${message}\n`); };

if (!app.requestSingleInstanceLock()) { app.exit(0); }
else {
  app.on('second-instance', (_event, argv) => { if (!attentionRouter.accept(argv)) showDashboard(); });
  app.on('activate', () => window?.show());
  app.on('window-all-closed', () => {}); // Closing a window leaves its owned session alive.
  app.on('before-quit', event => { log(`before-quit allowed=${allowQuit}`); if (!allowQuit) { event.preventDefault(); void requestQuit(); } });
  app.on('will-quit', () => log('will-quit'));
  app.on('quit', () => log('quit'));
  app.whenReady().then(start).catch(recoverStartup);
}

async function recoverStartup(error) {
  let recoveryLease;
  log(`startup failed at ${startupPhase}; user data retained`);
  if (smoke) {
    console.error(`DESKTOP_SMOKE_STARTUP_FAILED (${startupPhase}): ${error.message} ${smokeServiceDiagnostics}`);
    if (child?.sessionPort && child.exitCode === null && child.signalCode === null) {
      // This mode owns a fresh hidden test profile. A broken renderer must not
      // prevent the backend's own idle check and normal shutdown of that profile.
      let lease;
      try { lease = shutdownGuard.acquire(); gate.locked = true; await api('prepare', 'POST'); await stop(lease); }
      catch { await cancel(lease).catch(() => {}); log('isolated smoke cleanup not confirmed; retained owner must be checked'); }
    }
    allowQuit = true; app.exit(1); return;
  }
  if (child?.sessionPort && child.exitCode === null && child.signalCode === null) {
    try { recoveryLease = await prepare(); await stop(recoveryLease); }
    catch { await cancel(recoveryLease).catch(() => {}); /* Keep an uncertain live owner; do not spawn a replacement. */ }
  }
  const canRetry = !child || child.exitCode !== null || child.signalCode !== null;
  const result = await dialog.showMessageBox({ type: 'error', title: 'OpenSpecBoard 시작 실패', message: '앱을 준비하지 못했습니다.', detail: `단계: ${startupPhase}\n업무 데이터는 보존됩니다. 진단 경로: ${join(userDirectory, 'logs')}${canRetry ? '' : '\n기존 서버 종료를 확인하지 못해 재실행을 보류합니다.'}`, buttons: canRetry ? ['다시 시도', '앱 종료'] : ['확인'] });
  if (!canRetry) return;
  if (result.response === 1) { allowQuit = true; app.quit(); return; }
  window?.destroy(); updateWindow?.destroy(); tray?.destroy(); gateway?.closeAllConnections(); gateway?.close();
  for (const channel of ['status','check','install','attention-ready']) ipcMain.removeHandler(`desktop:${channel}`);
  allowQuit = false; gate.locked = false; gate.pending = 0; smokeServiceDiagnostics = '';
  shutdownGuard.release(recoveryLease);
  await start().catch(recoverStartup);
}

async function api(path, method = 'GET') {
  if (!child?.sessionPort || child.exitCode !== null) throw new Error('대화 서버 연결을 확인할 수 없습니다. 설치를 보류합니다.');
  const response = await fetch(`http://127.0.0.1:${child.sessionPort}/api/desktop/${path}`, { method, headers: { 'x-desktop-token': token }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('실행·연결·질문·승인 또는 처리 중인 요청이 있습니다. 업무 화면에서 처리한 뒤 다시 요청해 주세요.');
  return response.json();
}
async function prepare() {
  return shutdownGuard.prepare({ gate, probe: () => assertRendererClosable(window), api });
}
async function cancel(lease) {
  return shutdownGuard.cancel(lease, { gate, api });
}
async function stop(lease) {
  shutdownGuard.assertOwner(lease);
  stopping = true;
  try {
    await new Promise((resolve, reject) => {
      let backedUp = false;
      const timer = setTimeout(() => done(new Error('정상 종료를 확인할 수 없습니다')), 20000);
      const message = value => { if (value?.type === 'stopped') backedUp = true; if (value?.type === 'shutdown-error') done(new Error('백업 실패')); };
      const exit = code => done(backedUp && code === 0 ? undefined : new Error('대화 서버 종료 실패'));
      const done = error => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); error ? reject(error) : resolve(); };
      child.on('message', message); child.once('exit', exit);
      child.send({ type: 'shutdown' }, error => { if (error) done(error); });
    });
    if (gateway?.listening) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); }
    allowQuit = true; log('normal shutdown and backup completed');
  } finally { stopping = false; }
}
async function requestQuit() {
  if (shutdownRequested) return;
  if (child && (child.exitCode !== null || child.signalCode !== null) && !shutdownGuard.active) {
    gateway?.closeAllConnections(); gateway?.close(); allowQuit = true; app.quit(); return;
  }
  shutdownRequested = true;
  let lease;
  try { lease = await prepare(); await stop(lease); app.quit(); }
  catch (error) { await cancel(lease).catch(() => {}); await dialog.showMessageBox({ type: 'info', message: '앱 종료를 보류했습니다.', detail: error.message }); }
  finally { shutdownRequested = false; }
}
function showUpdates() {
  if (updateWindow && !updateWindow.isDestroyed()) { updateWindow.show(); updateWindow.focus(); return; }
  updateWindow = new BrowserWindow({ width: 550, height: 430, show: !smoke, title: 'OpenSpecBoard 업데이트', webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  updateWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  updateWindow.webContents.on('will-navigate', e => e.preventDefault());
  return updateWindow.loadFile(join(__dirname, 'updates.html'));
}
async function start() {
  startupPhase = 'session';
  attentionRouter.reset();
  const protocolReady = registerAttentionProtocol(app, process.execPath, process.defaultApp ? process.argv[1] : null, smoke);
  mkdirSync(dataDirectory, { recursive: true });
  if (smoke) writeFileSync(join(dataDirectory, 'notifications.json'), JSON.stringify({ enabled: false, dashboardUrl: 'http://127.0.0.1:13001/' }));
  child = spawn(nodeBinary, [join(serviceDirectory, 'backend', 'dist', 'desktop-main.js')], {
    cwd: userDirectory, windowsHide: true, stdio: ['ignore', 'ignore', smoke ? 'pipe' : 'ignore', 'ipc'],
    env: { ...process.env, DESKTOP_TOKEN: token, DATA_DIR: dataDirectory, CONFIG_PATH: configPath, OPENSPEC_NOTIFICATION_TARGET: 'desktop', OPENSPEC_DESKTOP_PROTOCOL_READY: protocolReady ? '1' : '0', OPENSPEC_NODE_DIRECTORY: nodeDirectory, PATH: `${nodeDirectory}${require('node:path').delimiter}${process.env.PATH || ''}` },
  });
  if (smoke) child.stderr.on('data', chunk => { smokeServiceDiagnostics = (smokeServiceDiagnostics + chunk).slice(-4000); });
  const sessionPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('서비스 준비 시간 초과')), 30000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('동봉 Node 실행 실패')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('서비스 시작 실패')); });
    child.on('message', value => {
      if (value?.type === 'ready' && Number.isInteger(value.port) && value.port > 0) { clearTimeout(timer); resolve(value.port); }
      if (value?.type === 'startup-error') { clearTimeout(timer); reject(new Error('서비스 초기화 실패')); }
    });
  });
  child.sessionPort = sessionPort;
  startupPhase = 'gateway';
  const { createGateway } = require(join(serviceDirectory, 'backend', 'dist', 'gateway.js'));
  gateway = createGateway(sessionPort, dataDirectory, { staticDirectory: join(serviceDirectory, 'frontend'), token, gate });
  await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${gateway.address().port}`;
  startupPhase = 'window';
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 900, minHeight: 600, title: 'OpenSpecBoard', show: false, webPreferences: { preload: join(__dirname, 'dashboard-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  ipcMain.handle('desktop:attention-ready', event => {
    if (!trustedAttentionSender(event, window, origin)) throw new Error('허용되지 않은 알림 요청입니다');
    attentionRouter.ready(); return true;
  });
  window.webContents.on('did-start-loading', () => attentionRouter.reset());
  const session = window.webContents.session;
  session.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    const allowed = details.webContentsId === window.webContents.id;
    callback(allowed ? { requestHeaders: { ...details.requestHeaders, 'x-desktop-token': token } } : { cancel: true });
  });
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const external = url => { try { const u = new URL(url); if (['https:','http:'].includes(u.protocol) && !u.username && !u.password) void shell.openExternal(u.href); } catch {} };
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${origin}/`)) { event.preventDefault(); external(url); } });
  window.on('close', event => { log(`window-close allowed=${allowQuit}`); if (!allowQuit) { event.preventDefault(); window.hide(); } });
  window.webContents.on('will-prevent-unload', () => log('window-unload-veto; unsaved UI retained'));
  child.on('exit', () => { if (!stopping && !allowQuit) { log('session lost; automatic duplicate restart prevented'); void dialog.showMessageBox({ type: 'error', message: '대화 서버 연결이 끊겼습니다.', detail: '업무 데이터를 보존했습니다. 실행 상태를 확인한 뒤 앱을 다시 실행해 주세요.' }); } });

  startupPhase = 'updater';
  const { autoUpdater } = require(join(serviceDirectory, 'node_modules', 'electron-updater'));
  const policy = require(join(__dirname, 'release-policy.json'));
  autoUpdater.logger = null;
  configureUpdateSelection(autoUpdater, { platform: process.platform, arch: process.arch });
  const updatesEnabled = allowPersonalUpdates(policy, app.isPackaged);
  if (updatesEnabled) autoUpdater.setFeedURL({ provider: 'github', owner: 'sklee385', repo: 'open_spec_dashboard' });
  manager = new UpdateManager({ updater: autoUpdater, enabled: updatesEnabled, prepare, stop, cancel, version: app.getVersion() });
  for (const [channel, operation] of [['status', () => manager.snapshot()], ['check', () => manager.check()], ['install', () => manager.install()]]) {
    ipcMain.handle(`desktop:${channel}`, event => {
      if (event.sender !== updateWindow?.webContents || event.senderFrame !== updateWindow?.webContents.mainFrame || event.senderFrame?.url !== updateURL) throw new Error('허용되지 않은 앱 요청입니다');
      return operation();
    });
  }
  startupPhase = 'tray';
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFUlEQVR42mNkYPj/n4ECwESJ5lEDRg0AAH6zAh8HBnNmAAAAAElFTkSuQmCC');
  tray = new Tray(icon); tray.setToolTip('OpenSpecBoard · 창을 닫아도 업무를 유지합니다');
  const menu = Menu.buildFromTemplate([{ label: 'OpenSpecBoard 열기', click: () => window.show() }, { label: '앱 업데이트', click: showUpdates }, { type: 'separator' }, { label: '앱 종료', click: () => void requestQuit() }]);
  tray.setContextMenu(menu); tray.on('double-click', () => window.show());
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'OpenSpecBoard', submenu: [{ label: '앱 업데이트', click: showUpdates }, { label: '앱 종료', click: () => void requestQuit() }] }, { role: 'editMenu' }, { role: 'viewMenu' }]));
  startupPhase = 'page';
  await window.loadURL(attentionRouter.initialURL(origin)); if (!smoke) window.show(); log('desktop ready');
  if (smoke) {
    const rendererSafe = await window.webContents.executeJavaScript("typeof require === 'undefined' && typeof process === 'undefined' && typeof window.desktopUpdates === 'undefined'");
    if (!rendererSafe) throw new Error('대시보드 렌더러의 권한 격리 실패');
    await showUpdates();
    for (const target of [window, updateWindow]) {
      const preferences = target.webContents.getLastWebPreferences();
      if (!preferences.sandbox || !preferences.contextIsolation || preferences.nodeIntegration) throw new Error('창의 렌더러 격리 설정 불일치');
    }
    const updateStatus = await updateWindow.webContents.executeJavaScript('window.desktopUpdates.status()');
    if (updateStatus.currentVersion !== app.getVersion() || !['idle', 'disabled'].includes(updateStatus.state)) throw new Error('소유 메인 프레임의 업데이트 IPC 실패');
    if (process.argv.includes('--desktop-personal-update-test')) {
      if (!updatesEnabled || updateStatus.state !== 'idle') throw new Error('개인용 GitHub 업데이트가 활성화되지 않았습니다');
      console.log('DESKTOP_PERSONAL_UPDATE_READY');
    }
    console.log('DESKTOP_SECURITY_READY');
    const status = await api('status');
    if (!status.idle) throw new Error('격리한 앱이 유휴 상태가 아닙니다');
    const sources = await fetch(`${origin}/api/sources`, { headers: { 'x-desktop-token': token } }).then(r => r.json());
    if (sources.sources.length) throw new Error('새 프로필에 프로젝트가 자동 등록되었습니다');
    if (process.argv.includes('--desktop-lifecycle-test')) {
      window.close();
      if (window.isDestroyed() || window.isVisible()) throw new Error('창 닫기 후 백그라운드 유지 실패');
      tray.emit('double-click');
      if (!window.isVisible()) throw new Error('트레이 재열기 콜백 실패');
      window.hide();
      if (!(await api('status')).idle) throw new Error('창 닫기 후 소유 서비스 접근 실패');
      console.log('DESKTOP_LIFECYCLE_READY');
    }
    console.log('DESKTOP_SMOKE_READY');
    await requestQuit(); return;
  }
  app.once('will-quit', startUpdateChecks(manager));
}
