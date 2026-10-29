const { EventEmitter } = require('node:events');
class UpdateManager extends EventEmitter {
  constructor({ updater, enabled, prepare, stop, cancel, assertInstallAllowed = () => {}, version = '' }) {
    super(); Object.assign(this, { updater, enabled, prepare, stop, cancel, assertInstallAllowed });
    this.installHandoff = false;
    this.value = { state: enabled ? 'idle' : 'disabled', currentVersion: version, targetVersion: '', percent: 0, message: enabled ? '' : '개발·일반 검사 빌드에서는 자동 업데이트를 사용하지 않습니다. 개인용 업데이트 배포 파일을 설치해 주세요.' };
    this.downloaded = false; this.busy = false; this.checking = false;
    updater.autoDownload = true; updater.autoInstallOnAppQuit = false; updater.allowDowngrade = false; updater.allowPrerelease = false;
    updater.on('checking-for-update', () => this.set('checking'));
    updater.on('update-not-available', () => this.set('current'));
    updater.on('update-available', info => this.set('downloading', { targetVersion: info.version, percent: 0 }));
    updater.on('download-progress', info => this.set('downloading', { percent: Math.round(info.percent) }));
    updater.on('update-downloaded', info => { if (!enabled) return; this.downloaded = true; this.set('ready', { targetVersion: info.version, percent: 100 }); });
    updater.on('error', () => { this.downloaded = false; this.set('error', { message: '업데이트 확인·다운로드·검증에 실패했습니다. 네트워크와 배포 파일을 확인한 뒤 다시 시도해 주세요.' }); });
  }
  snapshot() { return { ...this.value }; }
  set(state, rest = {}) { this.value = { ...this.value, state, message: '', ...rest }; this.emit('change', this.snapshot()); }
  async check() {
    if (!this.enabled || this.busy || this.checking || this.downloaded || ['checking','downloading','installing'].includes(this.value.state)) return this.snapshot();
    this.checking = true;
    this.set('checking');
    try {
      const result = await this.updater.checkForUpdates();
      await result?.downloadPromise;
    }
    catch { if (this.value.state !== 'error') this.set('error', { message: '업데이트 확인·다운로드를 완료하지 못했습니다. 연결을 확인한 뒤 재시도해 주세요.' }); }
    finally { this.checking = false; }
    return this.snapshot();
  }
  async install() {
    if (!this.enabled || !this.downloaded || this.busy || this.value.state === 'installing') return this.snapshot();
    this.busy = true;
    let lease;
    try {
      try { lease = await this.prepare(); }
      catch (e) { this.set('waiting', { message: e.message || '업무가 유휴 상태가 되면 다시 요청해 주세요.' }); return this.snapshot(); }
      this.set('installing');
      try { await this.updater.prepareInstall?.(); await this.stop(lease); this.assertInstallAllowed(); this.installHandoff = true; await this.updater.quitAndInstall(false, true); }
      catch { this.installHandoff = false; await this.cancel(lease).catch(() => {}); this.set('error', { message: '정상 종료·백업·설치를 완료하지 못했습니다. 데이터는 보존됩니다. 앱을 다시 열어 복구 상태를 확인해 주세요.' }); }
    } finally { this.busy = false; }
    return this.snapshot();
  }
}
function startUpdateChecks(manager) {
  void manager.check();
  const timer = setInterval(() => void manager.check(), 4 * 60 * 60 * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
module.exports = { UpdateManager, startUpdateChecks };
