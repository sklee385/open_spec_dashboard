const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');
const { HealthWindow } = require('../health-window.cjs');

async function fixture() {
  const handlers = new Map(), calls = [], opened = [];
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); this.webContents.mainFrame = {}; this.webContents.setWindowOpenHandler = fn => { this.open = fn; }; }
    async loadFile(path) { this.webContents.mainFrame.url = pathToFileURL(path).href; }
    isDestroyed() { return false; } show() {} focus() {} destroy() {}
  }
  const controller = new HealthWindow({ BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    directory: join(__dirname, '..'), dialog: { showMessageBox: async () => ({ response: 0 }) },
    inspect: async () => ({ server: null, error: { code: 'connection' } }), api: async (...args) => { calls.push(args); return { safeMode: false }; },
    forceQuit: async () => calls.push(['force']), openWork: id => opened.push(id), onSafeMode() {}, journal: { record() {} },
  });
  await controller.show();
  const event = { sender: controller.window.webContents, senderFrame: controller.window.webContents.mainFrame };
  return { controller, handlers, event, calls, opened };
}
test('진단 IPC는 소유 진단 창의 정확한 프레임만 허용하고 서버 단절을 그대로 표시한다', async () => {
  const f = await fixture(), inspect = f.handlers.get('desktop:health-inspect');
  assert.equal((await inspect(f.event)).error.code, 'connection');
  await assert.rejects(inspect({ ...f.event, senderFrame: { url: f.event.senderFrame.url } }), /허용/);
  await assert.rejects(inspect({ ...f.event, sender: {} }), /허용/);
});
test('복구·중단·이동은 선택한 업무만 대상으로 하고 안전 모드 입력을 검증한다', async () => {
  const f = await fixture();
  await f.handlers.get('desktop:health-recover')(f.event, 'work-1');
  assert.deepEqual(f.calls[0], ['recover/work-1', 'POST']);
  await f.handlers.get('desktop:health-open-work')(f.event, 'work-1'); assert.deepEqual(f.opened, ['work-1']);
  await assert.rejects(f.handlers.get('desktop:health-recover')(f.event, '../../other'), /업무/);
  await assert.rejects(f.handlers.get('desktop:health-safe-mode')(f.event, 'false'), /boolean/);
  await f.handlers.get('desktop:health-safe-mode')(f.event, false);
  assert.deepEqual(f.calls[1], ['safe-mode', 'POST', { enabled: false }]);
});
