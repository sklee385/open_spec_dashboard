const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { join, dirname } = require('node:path');
const { mkdirSync, appendFileSync, readdirSync, writeFileSync, readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { UpdateManager, startUpdateChecks } = require('./updates.cjs');
const { configureUpdateSelection } = require('./update-selection.cjs');
const { allowPersonalUpdates, allowPortableUpdates } = require('./update-policy.cjs');
const { reportPortableReady, reportPortableFailure, isPortableUpdateLaunch, validateConfig } = require('./portable-swap.cjs');
const { assertRendererClosable } = require('./renderer-close.cjs');
const { RendererRecovery } = require('./renderer-recovery.cjs');
const { createDesktopApi } = require('./api-client.cjs');
const { RecoveryState, HealthJournal } = require('./recovery-state.cjs');
const { HealthWindow } = require('./health-window.cjs');
const { DraftStore, registerDraftBridge } = require('./drafts.cjs');
const { captureOwner, launchEmergency } = require('./emergency.cjs');
const { ShutdownGuard } = require('./shutdown-guard.cjs');
const shutdownGuard = new ShutdownGuard();
const { AttentionRouter, registerAttentionProtocol, trustedAttentionSender } = require('./attention-links.cjs');

let window, updateWindow, tray, child, gateway, manager, origin, rendererRecovery, healthWindow, ownerRecord;
let screenState = 'loading', forceRequested = false, emergencyLock = false, startupCount = 0, storageWarning = false, disposeDraftBridge;
function showDashboard() { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
const attentionRouter = new AttentionRouter({ send: target => window.webContents.send('desktop:attention', target), show: showDashboard });
attentionRouter.accept(process.argv);
let startupPhase = 'initialization';
let smokeServiceDiagnostics = '';
const smoke = process.argv.includes('--desktop-smoke-test');
const recoverySmoke = smoke && process.argv.includes('--desktop-recovery-test');
const forceSmoke = smoke && process.argv.includes('--desktop-force-test');
const postForceToken = process.argv.find(arg => /^--desktop-post-force-test=[a-f0-9]{32}$/.test(arg))?.split('=')[1];
let recoverySmokePrompts = 0;
let recoverySmokeReadyCount = 0, recoverySmokeReadyWaiter;
function waitForRecoverySmokeReady(after) {
  if (recoverySmokeReadyCount > after) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { recoverySmokeReadyWaiter = undefined; reject(new Error('격리 화면 준비 응답 시간 초과')); }, 15000);
    recoverySmokeReadyWaiter = () => { clearTimeout(timer); recoverySmokeReadyWaiter = undefined; resolve(); };
  });
}
if (smoke) {
  if (!process.env.DESKTOP_SMOKE_DIRECTORY) throw new Error('격리한 smoke 데이터 경로가 필요합니다');
  mkdirSync(process.env.DESKTOP_SMOKE_DIRECTORY, { recursive: true });
  if (readdirSync(process.env.DESKTOP_SMOKE_DIRECTORY).length) {
    if (postForceToken) {
      const fixture = JSON.parse(readFileSync(join(process.env.DESKTOP_SMOKE_DIRECTORY, '.desktop-force-smoke.json'), 'utf8'));
      if (fixture.token !== postForceToken || fixture.version !== app.getVersion() || fixture.appDirectory !== dirname(process.execPath)) throw Error('격리 강제 종료 재시작 검사 소유권 불일치');
    } else {
    const matches = process.argv.filter(arg => /^--portable-update-job=[a-f0-9]{32}$/.test(arg));
    if (matches.length !== 1) throw new Error('smoke에는 비어 있는 새 프로필 경로가 필요합니다');
    const jobPath = join(process.env.DESKTOP_SMOKE_DIRECTORY, 'portable-updates', 'jobs', matches[0].split('=')[1], 'config.json');
    const job = validateConfig(JSON.parse(readFileSync(jobPath, 'utf8')), jobPath);
    if (job.smoke !== true || job.userDirectory.toLowerCase() !== process.env.DESKTOP_SMOKE_DIRECTORY.toLowerCase() || job.appDirectory.toLowerCase() !== dirname(process.execPath).toLowerCase() || job.version !== app.getVersion()) throw new Error('격리한 무설치 교체 검사 경로 불일치');
    }
  }
  app.setPath('userData', process.env.DESKTOP_SMOKE_DIRECTORY);
}
let allowQuit = false, stopping = false, shutdownRequested = false;
const gate = { locked: false, pending: 0 };
const token = randomBytes(32).toString('hex');
const userDirectory = app.getPath('userData');
const graphics = require('./graphics.cjs').configureGraphics(app, userDirectory, process.platform);
const serviceDirectory = app.isPackaged ? join(process.resourcesPath, 'service') : join(__dirname, '..', 'service');
const nodeDirectory = join(serviceDirectory, 'runtime');
const nodeBinary = join(nodeDirectory, process.platform === 'win32' ? 'node.exe' : 'node');
const dataDirectory = join(userDirectory, 'data');
const configPath = join(userDirectory, 'config.json');
const updateURL = pathToFileURL(join(__dirname, 'updates.html')).href;
const log = message => { try { mkdirSync(join(userDirectory, 'logs'), { recursive: true }); appendFileSync(join(userDirectory, 'logs', 'desktop.log'), `${new Date().toISOString()} ${message}\n`); } catch { storageWarning = true; } };
const recoveryState = new RecoveryState(userDirectory);
const healthJournal = new HealthJournal(userDirectory);
const recordHealth = (type, details) => { try { healthJournal.record(type, details); } catch { storageWarning = true; } };
const journal = { record: recordHealth };
function persistSafeMode(enabled) { recoveryState.safeMode = enabled; try { recoveryState.setSafeMode(enabled); } catch { storageWarning = true; } }
app.on('child-process-gone', (_event, details) => { if (details.type === 'GPU') log(`GPU process exited: ${details.reason}; hardwareAcceleration=${graphics.hardwareAcceleration}`); });
app.on('will-quit', () => rendererRecovery?.dispose());

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
  if (canRetry && isPortableUpdateLaunch(process.argv)) {
    await reportPortableFailure({ argv: process.argv, userDirectory, appDirectory: dirname(process.execPath), version: app.getVersion() });
    allowQuit = true; app.exit(1); return;
  }
  const result = await dialog.showMessageBox({ type: 'error', title: 'OpenSpecBoard 시작 실패', message: '앱을 준비하지 못했습니다.', detail: `단계: ${startupPhase}\n업무 데이터는 보존됩니다. 진단 경로: ${join(userDirectory, 'logs')}${canRetry ? '' : '\n기존 서버 종료를 확인하지 못해 재실행을 보류합니다.'}`, buttons: canRetry ? ['다시 시도', '앱 종료'] : ['확인'] });
  if (!canRetry) return;
  if (result.response === 1) { allowQuit = true; app.quit(); return; }
  disposeDraftBridge?.(); healthWindow?.dispose(); window?.destroy(); updateWindow?.destroy(); tray?.destroy(); gateway?.closeAllConnections(); gateway?.close();
  for (const channel of ['status','check','install','attention-ready']) ipcMain.removeHandler(`desktop:${channel}`);
  allowQuit = false; gate.locked = false; gate.pending = 0; smokeServiceDiagnostics = '';
  shutdownGuard.release(recoveryLease);
  await start().catch(recoverStartup);
}

const api = createDesktopApi({ child: () => child, token, fetchImpl: fetch });
async function inspectHealth() {
  const checkedAt = new Date().toISOString();
  const results = await Promise.allSettled([api('diagnostics'), (async () => {
    if (!window || window.isDestroyed()) return 'crashed';
    let timer;
    try {
      const ready = await Promise.race([window.webContents.executeJavaScript("document.readyState === 'complete' && (document.getElementById('root')?.childElementCount || 0) > 0"), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 1500); })]);
      return ready ? 'ready' : 'loading';
    } catch { return 'unresponsive'; } finally { clearTimeout(timer); }
  })()]);
  const server = results[0].status === 'fulfilled' ? results[0].value : null;
  const error = results[0].status === 'rejected' ? { code: results[0].reason.code || 'connection', message: results[0].reason.message } : undefined;
  screenState = results[1].status === 'fulfilled' ? results[1].value : 'unresponsive';
  recordHealth(error ? 'inspection-failed' : 'inspection-completed', { code: error?.code });
  if (server) recoveryState.safeMode = server.safeMode;
  return { checkedAt, server, error, desktop: { version: app.getVersion(), screen: screenState, safeMode: recoveryState.safeMode, ownerVerified: !!ownerRecord, storageWarning }, events: healthJournal.list() };
}
function showHealth() { return healthWindow?.show().catch(() => { log('health window unavailable'); }); }
async function requestForceQuit(normalAttempted = false) {
  if (forceRequested) return { requested: true };
  if (manager?.installHandoff) { await dialog.showMessageBox({ type: 'info', message: '업데이트 교체 도구로 종료를 인계했습니다.', detail: '앱 파일 교체가 끝날 때까지 기다려 주세요.' }); return { cancelled: true }; }
  const selectedOwner = ownerRecord;
  if (!selectedOwner) { await dialog.showMessageBox({ type: 'error', message: '앱 프로세스 소유권을 확인하지 못했습니다.', detail: '전체 상태 점검을 다시 요청해 주세요. 확인되지 않은 프로세스는 강제 종료하지 않습니다.' }); return { cancelled: true }; }
  const result = await dialog.showMessageBox({ type: 'warning', title: 'OpenSpecBoard 강제 종료', message: '앱과 이 앱이 실행한 작업을 종료할까요?',
    detail: '미저장 입력과 진행 중 파일·명령 변경이 중단될 수 있습니다. 강제 종료 뒤에는 안전 모드로 시작하며 작업을 자동 재실행하지 않습니다.',
    buttons: normalAttempted ? ['강제 종료', '취소'] : ['정상 종료 먼저 시도', '강제 종료', '취소'], defaultId: normalAttempted ? 1 : 0, cancelId: normalAttempted ? 1 : 2,
  });
  if (!normalAttempted && result.response === 0) { await requestQuit(); return { requested: true }; }
  if (result.response !== (normalAttempted ? 0 : 1)) return { cancelled: true };
  if (manager?.installHandoff) return { cancelled: true };
  if (selectedOwner !== ownerRecord) throw Error('확인 중 앱 실행 소유자가 변경됐습니다. 다시 점검해 주세요.');
  forceRequested = true; emergencyLock = true; gate.locked = true; persistSafeMode(true); recordHealth('force-exit-requested');
  const failed = async () => {
    if (!forceRequested) return;
    forceRequested = false; recordHealth('force-exit-unconfirmed');
    await dialog.showMessageBox({ type: 'error', message: '강제 종료를 확인하지 못했습니다.', detail: '작업 재실행은 보류합니다. 상태 점검을 다시 열거나 앱 폴더의 긴급 종료 도구를 사용해 주세요.' });
  };
  try { await launchEmergency({ ownerPath: selectedOwner.ownerPath, confirm: true, expectedNonce: selectedOwner.nonce, onFailure: () => { void failed().catch(() => {}); } }); }
  catch { await failed(); return { cancelled: true }; }
  const timer = setTimeout(() => { void failed().catch(() => {}); }, 35000); timer.unref?.();
  return { requested: true };
}
async function prepare() {
  assertNoEmergency();
  const lease = await shutdownGuard.prepare({ gate, probe: async () => { assertNoEmergency(); await assertRendererClosable(window); assertNoEmergency(); }, api: (...args) => { assertNoEmergency(); return api(...args); } });
  if (emergencyLock) { await cancel(lease).catch(() => {}); assertNoEmergency(); }
  return lease;
}
function assertNoEmergency() { if (emergencyLock) throw Error('긴급 종료를 요청하여 새 종료·업데이트 설치를 보류합니다.'); }
async function cancel(lease) {
  try { return await shutdownGuard.cancel(lease, { gate, api }); }
  finally { if (emergencyLock) gate.locked = true; }
}
async function stop(lease) {
  assertNoEmergency();
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
    assertNoEmergency();
    if (gateway?.listening) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); }
    assertNoEmergency();
    try { recoveryState.stopped(); } catch { storageWarning = true; }
    recordHealth('app-stopped'); allowQuit = true; log('normal shutdown and backup completed');
  } finally { stopping = false; }
}
async function requestQuit() {
  if (forceRequested) return;
  if (shutdownRequested) return;
  if (child && (child.exitCode !== null || child.signalCode !== null) && !shutdownGuard.active) {
    gateway?.closeAllConnections(); gateway?.close(); allowQuit = true; app.quit(); return;
  }
  shutdownRequested = true;
  let lease;
  try { lease = await prepare(); await stop(lease); app.quit(); }
  catch (error) {
    await cancel(lease).catch(() => {}); recordHealth('quit-blocked', { code: error.code });
    const result = await dialog.showMessageBox({ type: 'info', message: '앱 종료를 보류했습니다.', detail: error.message, buttons: ['전체 상태 점검', '강제 종료…', '닫기'], defaultId: 0, cancelId: 2 });
    if (result.response === 0) await showHealth();
    else if (result.response === 1) await requestForceQuit(true);
  }
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
  const safeStartup = recoveryState.safeMode || recoveryState.safeStartup || startupCount++ > 0 || process.env.OPENSPEC_SAFE_MODE === '1';
  recoveryState.safeMode = safeStartup;
  try { recoveryState.started(); } catch { recoveryState.safeMode = true; storageWarning = true; }
  recordHealth('app-started', { state: recoveryState.safeMode ? 'safe' : 'normal' });
  rendererRecovery?.dispose();
  rendererRecovery = undefined;
  let portableReported = false;
  const confirmPortableReady = async () => { if (!portableReported && isPortableUpdateLaunch(process.argv)) {
    const portableReady = await reportPortableReady({ argv: process.argv, userDirectory, appDirectory: dirname(process.execPath), version: app.getVersion() });
    if (!portableReady) throw new Error('무설치 업데이트 시작 확인 실패');
    portableReported = true;
  } };
  attentionRouter.reset();
  const protocolReady = registerAttentionProtocol(app, process.execPath, process.defaultApp ? process.argv[1] : null, smoke);
  mkdirSync(dataDirectory, { recursive: true });
  if (smoke) writeFileSync(join(dataDirectory, 'notifications.json'), JSON.stringify({ enabled: false, dashboardUrl: 'http://127.0.0.1:13001/' }));
  child = spawn(nodeBinary, [join(serviceDirectory, 'backend', 'dist', 'desktop-main.js')], {
    cwd: userDirectory, windowsHide: true, stdio: ['ignore', 'ignore', smoke ? 'pipe' : 'ignore', 'ipc'],
    env: { ...process.env, OPENSPEC_SAFE_MODE: recoveryState.safeMode ? '1' : '0', DESKTOP_TOKEN: token, DATA_DIR: dataDirectory, CONFIG_PATH: configPath, OPENSPEC_NOTIFICATION_TARGET: 'desktop', OPENSPEC_DESKTOP_PROTOCOL_READY: protocolReady ? '1' : '0', OPENSPEC_NODE_DIRECTORY: nodeDirectory, OPENSPEC_BROWSER_DIRECTORY: join(serviceDirectory, 'browser-runtime'), PATH: `${nodeDirectory}${require('node:path').delimiter}${process.env.PATH || ''}` },
  });
  if (smoke) child.stderr.on('data', chunk => { smokeServiceDiagnostics = (smokeServiceDiagnostics + chunk).slice(-4000); });
    ownerRecord = undefined;
    const ownerCapture = app.isPackaged && Number.isSafeInteger(process.pid) && Number.isSafeInteger(child.pid)
      ? captureOwner({ appDirectory: dirname(process.execPath), userDirectory, pid: process.pid, childPid: child.pid }).then(owner => { ownerRecord = owner; }).catch(() => { recordHealth('owner-unavailable'); log('emergency owner could not be verified'); })
      : Promise.resolve();
  const sessionPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('서비스 준비 시간 초과')), 30000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('동봉 Node 실행 실패')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('서비스 시작 실패')); });
    child.on('message', value => {
      if (value?.type === 'ready' && Number.isInteger(value.port) && value.port > 0) { clearTimeout(timer); resolve(value.port); }
      if (value?.type === 'startup-error') { clearTimeout(timer); reject(new Error('서비스 초기화 실패')); }
    });
  }).finally(() => ownerCapture);
  child.sessionPort = sessionPort;
  healthWindow = new HealthWindow({ BrowserWindow, ipcMain, directory: __dirname, dialog, inspect: inspectHealth, api, forceQuit: () => requestForceQuit(), journal, onSafeMode: persistSafeMode,
    openWork: id => { window?.webContents.send('desktop:open-work', id); showDashboard(); },
  });
  startupPhase = 'gateway';
  const { createGateway } = require(join(serviceDirectory, 'backend', 'dist', 'gateway.js'));
  gateway = createGateway(sessionPort, dataDirectory, { staticDirectory: join(serviceDirectory, 'frontend'), token, gate });
  await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${gateway.address().port}`;
  startupPhase = 'window';
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 900, minHeight: 600, title: 'OpenSpecBoard', show: false, webPreferences: { preload: join(__dirname, 'dashboard-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  disposeDraftBridge = registerDraftBridge({ ipcMain, window, origin, store: new DraftStore(userDirectory) });
  if (!smoke || recoverySmoke) {
    const dashboard = window;
    const recoveryDialog = recoverySmoke ? { showMessageBox: async () => { recoverySmokePrompts++; return { response: 0 }; } } : dialog;
    rendererRecovery = new RendererRecovery({ window: dashboard, dialog: recoveryDialog, log,
      reload: () => dashboard.loadURL(attentionRouter.initialURL(origin)),
      isStopping: () => stopping || allowQuit || forceRequested || shutdownGuard.active || gate.locked,
    });
  }
  ipcMain.handle('desktop:attention-ready', event => {
    if (!trustedAttentionSender(event, window, origin)) throw new Error('허용되지 않은 알림 요청입니다');
    if (recoverySmoke) { recoverySmokeReadyCount++; recoverySmokeReadyWaiter?.(); }
    rendererRecovery?.ready();
    screenState = 'ready';
    if (!smoke) void confirmPortableReady().catch(() => log('portable readiness report failed; retained update diagnostics'));
    attentionRouter.ready(); return true;
  });
  window.webContents.on('did-start-loading', () => { screenState = 'loading'; attentionRouter.reset(); });
  window.webContents.on('render-process-gone', () => { screenState = 'crashed'; recordHealth('screen-error', { code: 'renderer-gone' }); });
  window.on('unresponsive', () => { screenState = 'unresponsive'; recordHealth('screen-error', { code: 'unresponsive' }); });
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
  window.webContents.on('will-prevent-unload', event => {
    if (rendererRecovery?.reloading) { event.preventDefault(); log('window-unload allowed by explicit screen recovery'); }
    else log('window-unload-veto; unsaved UI retained');
  });
  child.on('exit', () => { if (!stopping && !allowQuit && !forceRequested) { recordHealth('server-exited'); log('session lost; automatic duplicate restart prevented'); void showHealth(); } });

  startupPhase = 'updater';
  const policy = require(join(__dirname, 'release-policy.json'));
  const portableUpdates = allowPortableUpdates(policy, app.isPackaged);
  const updatesEnabled = portableUpdates || allowPersonalUpdates(policy, app.isPackaged);
  let updater;
  if (portableUpdates) {
    const { PortableUpdater } = require('./portable-updater.cjs');
    const { preparePortableInstall } = require('./portable-install.cjs');
    updater = new PortableUpdater({ version: app.getVersion(), userDirectory, prepareInstall: async args => {
      const prepared = await preparePortableInstall({ ...args, appDirectory: dirname(process.execPath), userDirectory, nodeBinary, unzipper: require(join(serviceDirectory, 'node_modules', 'unzipper')) });
      await assertRendererClosable(window);
      return prepared;
    }, exit: () => app.quit() });
  } else {
    const { autoUpdater } = require(join(serviceDirectory, 'node_modules', 'electron-updater'));
    autoUpdater.logger = null;
    configureUpdateSelection(autoUpdater, { platform: process.platform, arch: process.arch });
    if (updatesEnabled) autoUpdater.setFeedURL({ provider: 'github', owner: 'sklee385', repo: 'open_spec_dashboard' });
    updater = autoUpdater;
  }
  manager = new UpdateManager({ updater, enabled: updatesEnabled, prepare, stop, cancel, assertInstallAllowed: assertNoEmergency, version: app.getVersion() });
  for (const [channel, operation] of [['status', () => manager.snapshot()], ['check', () => manager.check()], ['install', () => manager.install()]]) {
    ipcMain.handle(`desktop:${channel}`, event => {
      if (event.sender !== updateWindow?.webContents || event.senderFrame !== updateWindow?.webContents.mainFrame || event.senderFrame?.url !== updateURL) throw new Error('허용되지 않은 앱 요청입니다');
      return operation();
    });
  }
  startupPhase = 'tray';
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFUlEQVR42mNkYPj/n4ECwESJ5lEDRg0AAH6zAh8HBnNmAAAAAElFTkSuQmCC');
  tray = new Tray(icon); tray.setToolTip('OpenSpecBoard · 창을 닫아도 업무를 유지합니다');
  const recoverScreen = () => { void rendererRecovery?.report('manual'); };
  const menu = Menu.buildFromTemplate([{ label: 'OpenSpecBoard 열기', click: () => window.show() }, { label: '전체 상태 점검', click: () => void showHealth() }, { label: '화면 복구', click: recoverScreen }, { label: '앱 업데이트', click: showUpdates }, { type: 'separator' }, { label: '앱 종료', click: () => void requestQuit() }, { label: '강제 종료…', click: () => { void requestForceQuit().catch(() => {}); } }]);
  tray.setContextMenu(menu); tray.on('double-click', () => window.show());
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'OpenSpecBoard', submenu: [{ label: '전체 상태 점검', click: () => void showHealth() }, { label: '화면 복구', click: recoverScreen }, { label: '앱 업데이트', click: showUpdates }, { label: '앱 종료', click: () => void requestQuit() }, { label: '강제 종료…', click: () => { void requestForceQuit().catch(() => {}); } }] }, { role: 'editMenu' }, { role: 'viewMenu' }]));
  startupPhase = 'page';
  try { await window.loadURL(attentionRouter.initialURL(origin)); }
  catch (error) {
    if (smoke) throw error;
    await rendererRecovery.report('load-failed');
  }
  if (!smoke) window.show(); log('desktop page loaded; awaiting renderer readiness');
  if (!smoke && recoveryState.safeMode) await showHealth();
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
    if (process.argv.includes('--desktop-health-test')) {
      const initial = await inspectHealth();
      if (!initial.server?.idle || !Array.isArray(initial.server.works) || !initial.desktop.ownerVerified) throw Error('실제 소유 프로세스·전체 상태 점검 실패');
      if (postForceToken) {
        const saved = await window.webContents.executeJavaScript("window.desktopDrafts.getItem('work-chat-draft:force-smoke')");
        const first = JSON.parse(readFileSync(join(userDirectory, '.desktop-force-smoke.json'), 'utf8'));
        if (first.origin === origin || !initial.server.safeMode || saved !== 'isolated-restart-draft') throw Error('강제 종료 후 새 origin·안전 시작·프로필 초안 복원 실패');
        console.log('DESKTOP_POST_FORCE_READY');
      }
      await healthWindow.show();
      const healthContent = healthWindow.window.webContents;
      const waitUntil = Date.now() + 10000;
      let inspected = false;
      while (!inspected && Date.now() < waitUntil) {
        inspected = await healthContent.executeJavaScript("document.getElementById('summary')?.textContent.includes('현재 종료를 막는') === true");
        if (!inspected) await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!inspected) throw Error('실제 진단 렌더러·고정 IPC 점검 실패');
      const enabled = await api('safe-mode', 'POST', { enabled: true }); persistSafeMode(enabled.safeMode);
      if (!(await inspectHealth()).server.safeMode) throw Error('안전 모드 적용 실패');
      const disabled = await api('safe-mode', 'POST', { enabled: false }); persistSafeMode(disabled.safeMode);
      if ((await inspectHealth()).server.safeMode) throw Error('안전 모드 명시적 해제 실패');
      console.log('DESKTOP_HEALTH_READY');
    }
    if (recoverySmoke) {
      await waitForRecoverySmokeReady(0);
      const sessionPid = child.pid;
      let afterCrash;
      const crashed = new Promise(resolve => window.webContents.once('render-process-gone', () => { afterCrash = recoverySmokeReadyCount; resolve(); }));
      window.webContents.forcefullyCrashRenderer();
      await crashed;
      await rendererRecovery.pending;
      await waitForRecoverySmokeReady(afterCrash);
      const recovered = await window.webContents.executeJavaScript("document.getElementById('root')?.textContent.includes('OpenSpecBoard') === true");
      if (!recovered || recoverySmokePrompts !== 1 || child.pid !== sessionPid || child.exitCode !== null || !(await api('status')).idle) throw new Error('격리 화면 충돌 복구 또는 동일 세션 유지 실패');
      console.log('DESKTOP_RECOVERY_READY');
    }
    const sources = await fetch(`${origin}/api/sources`, { headers: { 'x-desktop-token': token } }).then(r => r.json());
    if (sources.sources.length && !isPortableUpdateLaunch(process.argv)) throw new Error('새 프로필에 프로젝트가 자동 등록되었습니다');
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
    if (forceSmoke) {
      if (!ownerRecord) throw Error('격리 강제 종료 소유권 미확인');
      await window.webContents.executeJavaScript("window.desktopDrafts.setItem('work-chat-draft:force-smoke', 'isolated-restart-draft')");
      writeFileSync(join(userDirectory, '.desktop-force-smoke.json'), JSON.stringify({ token: ownerRecord.nonce, version: app.getVersion(), appDirectory: dirname(process.execPath), origin }));
      forceRequested = true; emergencyLock = true; persistSafeMode(true);
      console.log('DESKTOP_FORCE_READY');
      await launchEmergency({ ownerPath: ownerRecord.ownerPath, confirm: true, expectedNonce: ownerRecord.nonce });
      await new Promise(() => {}); return;
    }
    await confirmPortableReady();
    await requestQuit(); return;
  }
  app.once('will-quit', startUpdateChecks(manager));
}
