const test = require('node:test');
const assert = require('node:assert/strict');
const { registerWorkspacePicker } = require('../workspace-picker.cjs');
function fixture(result = { canceled: false, filePaths: ['D:\\업무 공간'] }) {
  let handler, calls = 0, locked = false;
  const frame = { url: 'http://127.0.0.1:4567/' }, contents = { mainFrame: frame };
  const window = { webContents: contents, isDestroyed: () => false };
  registerWorkspacePicker({ ipcMain: { handle(channel, callback) { assert.equal(channel, 'desktop:workspace-folder'); handler = callback; } }, dialog: { async showOpenDialog(parent, options) { calls++; assert.equal(parent, window); assert.deepEqual(options.properties, ['openDirectory']); return result; } }, window: () => window, origin: () => 'http://127.0.0.1:4567', locked: () => locked });
  return { handler, event: { sender: contents, senderFrame: frame }, calls: () => calls, lock: () => { locked = true; } };
}
test('dashboard folder selection returns only a host path and preserves cancellation', async () => {
  const f = fixture(); assert.equal(typeof f.handler, 'function');
  assert.deepEqual(await f.handler(f.event), { cancelled: false, path: 'D:\\업무 공간' });
  assert.equal(f.calls(), 1);
  const cancelled = fixture({ canceled: true, filePaths: [] });
  assert.deepEqual(await cancelled.handler(cancelled.event), { cancelled: true });
});
test('untrusted frames and shutdown cannot open a host folder dialog', async () => {
  const f = fixture(); assert.equal(typeof f.handler, 'function');
  await assert.rejects(async () => f.handler({ ...f.event, senderFrame: { url: f.event.senderFrame.url } }));
  f.lock(); await assert.rejects(async () => f.handler(f.event)); assert.equal(f.calls(), 0);
});
