class RendererRecovery {
  constructor({ window, dialog, reload, log, isStopping, timeout = 30000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { window, dialog, reload, log, isStopping, timeout, setTimer, clearTimer });
    this.disposed = false;
    this.reloading = false;
    this.pending = null;
    this.handlers = [
      [window.webContents, 'did-start-loading', () => this.loading()],
      [window.webContents, 'did-fail-load', (_event, code, _description, _url, mainFrame) => {
        if (mainFrame !== false && code !== -3) void this.report('load-failed');
      }],
      [window.webContents, 'render-process-gone', () => { void this.report('renderer-gone'); }],
      [window, 'unresponsive', () => { void this.report('unresponsive'); }],
      [window, 'closed', () => this.dispose()],
    ];
    for (const [emitter, name, handler] of this.handlers) emitter.on(name, handler);
  }
  ready() { if (this.timer !== undefined) this.clearTimer(this.timer); this.timer = undefined; }
  loading() {
    this.ready();
    if (this.disposed || this.isStopping()) return;
    this.timer = this.setTimer(() => this.report('ready-timeout'), this.timeout);
    this.timer?.unref?.();
  }
  available() { return !this.disposed && !this.window.isDestroyed() && !this.isStopping(); }
  report(reason) {
    if (!this.available()) return Promise.resolve();
    if (this.pending) return this.pending;
    this.ready();
    this.log(`renderer recovery: ${reason}`);
    // Defer one microtask so reentrant/duplicate failures share the same prompt.
    this.pending = Promise.resolve().then(async () => {
      if (!this.available()) return;
      const result = await this.dialog.showMessageBox(this.window, {
        type: 'warning', title: 'OpenSpecBoard 화면 복구', message: '업무 화면을 표시하지 못하거나 응답이 없습니다.',
        detail: '화면만 다시 불러올 수 있습니다. 미저장 입력은 사라질 수 있습니다. 실행 중 업무와 대화 서버는 유지됩니다.',
        buttons: ['화면 다시 불러오기', '취소'], defaultId: 1, cancelId: 1,
      });
      if (result.response !== 0 || !this.available()) return;
      try { this.reloading = true; await this.reload(); }
      catch {
        this.ready();
        this.log('renderer recovery: reload-failed');
        if (this.available()) await this.dialog.showMessageBox(this.window, {
          type: 'error', title: 'OpenSpecBoard 화면 복구', message: '화면을 다시 불러오지 못했습니다.',
          detail: '대화 서버와 업무 데이터는 유지됩니다. 앱 메뉴에서 화면 복구를 다시 요청하거나 로그를 확인해 주세요.', buttons: ['확인'],
        });
      }
      finally { this.reloading = false; }
    }).catch(() => { this.log('renderer recovery: dialog-failed'); }).finally(() => { this.pending = null; });
    return this.pending;
  }
  dispose() {
    this.disposed = true;
    this.ready();
    for (const [emitter, name, handler] of this.handlers) emitter.off(name, handler);
  }
}
module.exports = { RendererRecovery };
