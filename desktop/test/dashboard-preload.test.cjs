const test = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), vm = require('node:vm');
test('dashboard bridge exposes only notification subscription and a fixed readiness call', async () => {
  let api, eventName, listener, removed = false; const calls = [];
  vm.runInNewContext(readFileSync(join(__dirname, '../dashboard-preload.cjs'), 'utf8'), { require: name => {
    assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'desktopAttention'); api = value; } }, ipcRenderer: {
      on(name, callback) { eventName = name; listener = callback; }, removeListener(name, callback) { assert.equal(name, eventName); assert.equal(callback, listener); removed = true; }, invoke: async name => calls.push(name),
    } };
  } });
  assert.deepEqual(Object.keys(api).sort(), ['onRequest','ready']); const values = []; const unsubscribe = api.onRequest(value => values.push(JSON.parse(JSON.stringify(value))));
  assert.equal(eventName, 'desktop:attention'); listener({}, { workId: 'w', questionId: 'q', token: 'secret' }); listener({}, { url: 'https://evil.example/' }); listener({}, { invalid: true, token: 'secret' });
  assert.deepEqual(values, [{ workId: 'w', questionId: 'q' }, { invalid: true }]); await api.ready(); assert.deepEqual(calls, ['desktop:attention-ready']); unsubscribe(); assert.equal(removed, true);
});
