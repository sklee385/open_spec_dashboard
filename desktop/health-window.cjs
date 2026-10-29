const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
class HealthWindow {
  constructor(options) {
    Object.assign(this, options); this.window = null; this.operation = false;
    this.url = pathToFileURL(join(this.directory, 'health.html')).href;
    const workId = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(value)) throw Error('업무 식별자가 잘못되었습니다'); return value; };
    const handlers = {
      inspect: () => this.inspect(),
      recover: id => this.workAction('recover', workId(id)),
      interrupt: id => this.workAction('interrupt', workId(id)),
      'open-work': id => this.openWork(workId(id)),
      'safe-mode': async enabled => {
        if (typeof enabled !== 'boolean') throw Error('enabled는 boolean이어야 합니다');
        return this.mutate(async () => {
          if (!enabled && !await this.confirm('안전 모드를 해제할까요?', '보류한 메시지는 자동 전송하지 않습니다. 점검 결과를 확인한 후 직접 작업을 시작해 주세요.')) return { cancelled: true };
          const result = await this.api('safe-mode', 'POST', { enabled });
          this.onSafeMode(result.safeMode); this.journal.record('safe-mode-changed', { state: result.safeMode ? 'enabled' : 'disabled' }); return result;
        });
      },
      force: () => this.forceQuit(),
    };
    this.channels = Object.keys(handlers).map(name => `desktop:health-${name}`);
    for (const [name, operation] of Object.entries(handlers)) this.ipcMain.handle(`desktop:health-${name}`, async (event, value) => {
      const content = this.window?.webContents;
      if (!content || this.window.isDestroyed() || event.sender !== content || event.senderFrame !== content.mainFrame || event.senderFrame?.url !== this.url) throw Error('허용되지 않은 상태 점검 요청입니다');
      return operation(value);
    });
  }
  async confirm(message, detail) { return (await this.dialog.showMessageBox(this.window, { type: 'warning', title: 'OpenSpecBoard 상태 복구', message, detail, buttons: ['진행', '취소'], defaultId: 1, cancelId: 1 })).response === 0; }
  async mutate(action) { if (this.operation) throw Error('다른 복구 요청을 처리 중입니다'); this.operation = true; try { return await action(); } finally { this.operation = false; } }
  workAction(action, id) {
    return this.mutate(async () => {
      const recover = action === 'recover';
      if (!await this.confirm(recover ? '선택한 업무의 저장 상태를 복구할까요?' : '선택한 업무의 실행을 중단 요청할까요?', recover ? '실제 실행이 없는지 다시 확인한 뒤 오래된 상태만 정리합니다. 메시지·승인·실행을 자동 재시도하지 않습니다.' : '해당 업무에만 중단을 요청합니다. 완료 여부는 상태 재점검으로 확인해 주세요.')) return { cancelled: true };
      const result = await this.api(`${action}/${id}`, 'POST'); this.journal.record(`work-${action}-requested`, { workId: id }); return result;
    });
  }
  async show() {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return; }
    const window = this.window = new this.BrowserWindow({ width: 1060, height: 780, minWidth: 680, minHeight: 560, show: false, title: 'OpenSpecBoard 상태 점검', webPreferences: { preload: join(this.directory, 'health-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    await window.loadFile(join(this.directory, 'health.html')); window.show();
  }
  dispose() { for (const channel of this.channels) this.ipcMain.removeHandler(channel); if (this.window && !this.window.isDestroyed()) this.window.destroy(); this.window = null; }
}
module.exports = { HealthWindow };
