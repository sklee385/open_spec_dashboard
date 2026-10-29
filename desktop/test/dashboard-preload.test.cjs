const test = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), vm = require('node:vm');
test('dashboard exposes only fixed notification and work-recovery bridges', async () => {
  const apis = {}, listeners = new Map(), removed = [], calls = [], draftCalls = [];
  vm.runInNewContext(readFileSync(join(__dirname, '../dashboard-preload.cjs'), 'utf8'), { require: name => {
    assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(name, value) { assert.equal(apis[name], undefined); apis[name] = value; } }, ipcRenderer: {
      on(name, callback) { listeners.set(name, callback); }, removeListener(name, callback) { assert.equal(callback, listeners.get(name)); removed.push(name); }, invoke: async (...args) => calls.push(args), sendSync: (...args) => { draftCalls.push(args); return { ok: args[2] !== 'fail', value: 'saved' }; },
    } };
  } });
  assert.deepEqual(Object.keys(apis).sort(), ['desktopAttention', 'desktopDrafts', 'desktopRecovery']);
  assert.deepEqual(Object.keys(apis.desktopDrafts).sort(), ['getItem','removeItem','setItem']);
  assert.equal(apis.desktopDrafts.getItem('work-draft:w'), 'saved');
  apis.desktopDrafts.setItem('work-draft:w', 'text'); apis.desktopDrafts.removeItem('work-draft:w');
  assert.deepEqual(draftCalls, [['desktop:draft','get','work-draft:w',undefined],['desktop:draft','set','work-draft:w','text'],['desktop:draft','remove','work-draft:w',undefined]]);
  assert.throws(() => apis.desktopDrafts.getItem('fail'), /초안 저장소/);
  const api = apis.desktopAttention;
  assert.deepEqual(Object.keys(api).sort(), ['onRequest','ready']); const values = []; const unsubscribe = api.onRequest(value => values.push(JSON.parse(JSON.stringify(value))));
  const listener = listeners.get('desktop:attention'); assert.equal(typeof listener, 'function'); listener({}, { workId: 'w', questionId: 'q', token: 'secret' }); listener({}, { url: 'https://evil.example/' }); listener({}, { invalid: true, token: 'secret' });
  assert.deepEqual(values, [{ workId: 'w', questionId: 'q' }, { invalid: true }]); await api.ready('arbitrary'); assert.deepEqual(calls, [['desktop:attention-ready']]); unsubscribe(); assert.deepEqual(removed, ['desktop:attention']);
  assert.deepEqual(Object.keys(apis.desktopRecovery), ['onOpenWork']);
  const workIds = [], unsubscribeRecovery = apis.desktopRecovery.onOpenWork(id => workIds.push(id));
  const recoveryListener = listeners.get('desktop:open-work'); assert.equal(typeof recoveryListener, 'function');
  recoveryListener({}, 'work_1-A');
  for (const invalid of ['', 'a'.repeat(151), '../work', 'w\n', { workId: 'w' }, null, 1, 'https://evil.example/']) recoveryListener({}, invalid);
  assert.deepEqual(workIds, ['work_1-A']);
  assert.deepEqual([...listeners.keys()].sort(), ['desktop:attention', 'desktop:open-work']);
  assert.deepEqual(calls, [['desktop:attention-ready']]);
  unsubscribeRecovery(); assert.deepEqual(removed, ['desktop:attention', 'desktop:open-work']);
});
