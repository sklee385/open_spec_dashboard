const { test } = require('node:test');
const assert = require('node:assert/strict');
let createBridge;
try { ({ createBridge } = require('../background.js')); } catch {}
function setup(saved = {}) {
  assert.equal(typeof createBridge, 'function', 'extension transport must exist');
  const state = { ...saved };
  const requests = [];
  const tab = { id: 7, url: 'https://example.test/page', title: 'Example', active: true, windowId: 4 };
  const chrome = {
    storage: { session: { get: async () => ({ ...state }), set: async values => Object.assign(state, values), remove: async key => { delete state[key]; } } },
    tabs: { get: async () => ({ ...tab }), query: async () => [{ ...tab }], captureVisibleTab: async () => 'data:image/png;base64,aGVsbG8=' },
    windows: { get: async () => ({ focused: true }) },
    scripting: { executeScript: async options => options.files ? [{ documentId: 'document-test' }] : [{ result: { url: tab.url } }] },
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    return { ok: true, status: 200, json: async () => url.endsWith('/pair') ? { token: 'token', workId: 'work' } : url.includes('/commands/') ? { valid: true } : { command: null } };
  };
  const bridge = createBridge(chrome, fetch);
  return { bridge, chrome, requests, state, tab };
}
async function paired() {
  const s = setup();
  await s.bridge.pair({ endpoint: 'http://127.0.0.1:4567', code: '123456' });
  return s;
}
const command = (op, args = {}) => ({ id: 'cmd', op, args, tabId: 7, expectedUrl: 'https://example.test/page', expiresAt: Date.now() + 20000 });
test('pair binds the current active tab and only accepts loopback endpoints', async () => {
  const s = await paired();
  assert.deepEqual(JSON.parse(s.requests[0].body), { code: '123456', tabId: 7, url: s.tab.url, title: 'Example' });
  await assert.rejects(s.bridge.pair({ endpoint: 'https://evil.test', code: '123' }), /loopback/i);
  assert.equal(s.state.connection.tabId, 7);
});
test('rejects wrong tab, origin/URL drift, and arbitrary operations before scripting', async () => {
  const s = await paired();
  let scripts = 0;
  s.chrome.scripting.executeScript = async () => { scripts++; return []; };
  await assert.rejects(s.bridge.execute({ ...command('observe'), tabId: 8 }), /tab/i);
  s.tab.url = 'https://example.test/other';
  await assert.rejects(s.bridge.execute(command('click')), /URL/i);
  s.tab.url = 'https://example.test/page';
  await assert.rejects(s.bridge.execute(command('eval')), /operation/i);
  assert.equal(scripts, 0);
  s.tab.url = 'https://evil.test/';
  await assert.rejects(s.bridge.execute(command('observe')), /site|origin|URL/i);
  assert.equal(s.bridge.status().connected, false);
  assert.equal(scripts, 0, 'revocation must not inject into the new unpaired site');
});
test('capture requires bound active tab and focused window', async () => {
  const s = await paired();
  assert.deepEqual(await s.bridge.execute(command('capture')), { image: 'data:image/png;base64,aGVsbG8=', url: s.tab.url });
  s.tab.active = false;
  await assert.rejects(s.bridge.execute(command('capture')), /active/i);
  s.tab.active = true;
  s.chrome.windows.get = async () => ({ focused: false });
  await assert.rejects(s.bridge.execute(command('capture')), /focused/i);
});
test('poll authenticates, submits operation result, and never replays a delivered command', async () => {
  const s = await paired();
  let scripts = 0;
  s.chrome.scripting.executeScript = async options => { if (options.files) return [{ documentId: 'document-test' }]; if (options.args[0] === 'observe') scripts++; return [{ documentId: 'document-test', result: { url: s.tab.url } }]; };
  const fetch = async (url, options = {}) => {
    s.requests.push({ url, ...options });
    return { ok: true, status: 200, json: async () => url.includes('/commands/') ? { valid: true } : ({ command: command('observe') }) };
  };
  const bridge = createBridge(s.chrome, fetch);
  await bridge.restore();
  await bridge.pollOnce();
  await bridge.pollOnce();
  assert.equal(scripts, 1);
  assert.equal(s.requests.at(-1).headers.Authorization, 'Bearer token');
  const result = s.requests.find(r => r.url.endsWith('/results'));
  assert.deepEqual(JSON.parse(result.body), { id: 'cmd', ok: true, result: { url: s.tab.url } });
});
test('worker recovery rejects uncertain persisted commands instead of replaying actions', async () => {
  const s = await paired();
  s.state.connection.inFlight = 'cmd';
  const recovered = createBridge(s.chrome, async (url, options) => { s.requests.push({ url, ...options }); return { ok: true, status: 200, json: async () => ({ command: null }) }; });
  await recovered.restore();
  assert.equal(JSON.parse(s.requests.at(-1).body).ok, false);
  assert.match(JSON.parse(s.requests.at(-1).body).error, /restart/i);
  assert.equal(s.state.connection.inFlight, null);
  await recovered.disconnect();
  assert.equal(s.state.connection, undefined);
  assert.equal(s.requests.at(-1).method, 'DELETE');
});
test('restore invalidates existing page observations before accepting new commands', async () => {
  const s = await paired();
  const ops = [];
  s.chrome.scripting.executeScript = async options => { if (options.args) ops.push(options.args[0]); return [{ documentId: 'document-test', result: { url: s.tab.url } }]; };
  await createBridge(s.chrome, async () => ({ ok: true, status: 200 })).restore();
  assert.deepEqual(ops, ['bind']);
});
test('tab lifecycle revokes closed tabs and origin changes, preserving same-origin navigation', async () => {
  const s = await paired();
  assert.equal(typeof s.bridge.tabChanged, 'function', 'Tab lifecycle handler must exist');
  await s.bridge.tabChanged(8, { removed: true });
  assert.equal(s.bridge.status().connected, true);
  await s.bridge.tabChanged(7, { url: 'https://example.test/next' });
  assert.equal(s.bridge.status().connected, true);
  await s.bridge.tabChanged(7, { url: 'https://other.test/' });
  assert.equal(s.bridge.status().connected, false);
  const closed = await paired();
  await closed.bridge.tabChanged(7, { removed: true });
  assert.equal(closed.bridge.status().connected, false);
});
test('unauthorized polling clears the connection and action failures submit errors', async () => {
  const s = await paired();
  const results = [];
  const bridge = createBridge(s.chrome, async (url, options) => {
    if (url.endsWith('/results')) results.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ command: command('eval') }) };
  });
  await bridge.restore();
  await bridge.pollOnce();
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /operation/i);
  const unauthorized = createBridge(s.chrome, async () => ({ ok: false, status: 401 }));
  await unauthorized.restore();
  await assert.rejects(unauthorized.pollOnce(), /401/);
  assert.equal(unauthorized.status().connected, false);
});
test('failed result delivery does not repeat an action', async () => {
  const s = await paired();
  let actions = 0;
  s.chrome.scripting.executeScript = async options => { if (options.args?.[0] === 'click') actions++; return [{ documentId: 'document-test', result: { url: s.tab.url } }]; };
  const bridge = createBridge(s.chrome, async url => {
    if (url.endsWith('/results')) throw new Error('Network interrupted');
    return { ok: true, status: 200, json: async () => url.includes('/commands/') ? { valid: true } : ({ command: command('click') }) };
  });
  await bridge.restore();
  await assert.rejects(bridge.pollOnce(), /Network/);
  await bridge.pollOnce();
  assert.equal(actions, 1);
});
test('capture refuses images above the bridge payload limit and tab switches during capture', async () => {
  const s = await paired();
  s.chrome.tabs.captureVisibleTab = async () => `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`;
  await assert.rejects(s.bridge.execute(command('capture')), /size|large/i);
  s.chrome.tabs.captureVisibleTab = async () => { s.tab.active = false; return 'data:image/png;base64,YQ=='; };
  await assert.rejects(s.bridge.execute(command('capture')), /changed/i);
});
test('recovery clears an expired uncertain command when the server already completed it', async () => {
  const s = await paired();
  s.state.connection.inFlight = 'expired';
  const bridge = createBridge(s.chrome, async () => ({ ok: false, status: 409 }));
  await bridge.restore();
  assert.equal(s.state.connection.inFlight, null);
  assert.equal(s.state.connection.lastId, 'expired');
});
test('pairing failures never retain a connection and restricted tabs cannot pair', async () => {
  const s = setup();
  const bridge = createBridge(s.chrome, async () => ({ ok: false, status: 401 }));
  await assert.rejects(bridge.pair({ endpoint: 'http://127.0.0.1:4567', code: 'expired' }), /401/);
  assert.equal(bridge.status().connected, false);
  s.tab.url = 'edge://extensions/';
  await assert.rejects(s.bridge.pair({ endpoint: 'http://127.0.0.1:4567', code: 'valid' }), /HTTP/);
  assert.equal(s.requests.length, 0);
});
test('observe refreshes the URL after same-origin navigation while actions stay URL-bound', async () => {
  const s = await paired();
  s.tab.url = 'https://example.test/new-document';
  const scripts = [];
  s.chrome.scripting.executeScript = async options => { scripts.push(options); return [{ documentId: 'document-test', result: { url: s.tab.url } }]; };
  assert.deepEqual(await s.bridge.execute(command('observe')), { url: s.tab.url });
  assert.equal(scripts.at(-1).args[3], s.tab.url);
  await assert.rejects(s.bridge.execute(command('fill')), /URL/i);
});
test('a delayed persisted command never crosses disconnect and re-pair ownership', async () => {
  const s = setup();
  let work = 1;
  const fetcher = async (url) => ({ ok: true, status: 200, json: async () => url.endsWith('/pair') ? { token: `token${work}`, workId: `work${work}` } : url.includes('/commands/') ? { valid: true } : { command: command('click') } });
  const bridge = createBridge(s.chrome, fetcher);
  await bridge.pair({ endpoint: 'http://127.0.0.1:4567', code: 'one' });
  const actions = [];
  s.chrome.scripting.executeScript = async options => { if (options.args?.[0] === 'click') actions.push(options); return [{ documentId: 'document-test', result: { url: s.tab.url } }]; };
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const originalSave = s.chrome.storage.session.set;
  let delay = true;
  s.chrome.storage.session.set = async values => {
    if (delay) { delay = false; started(); await new Promise(resolve => { release = resolve; }); }
    return originalSave(values);
  };
  const pending = bridge.pollOnce();
  await waiting;
  await bridge.disconnect();
  work = 2;
  await bridge.pair({ endpoint: 'http://127.0.0.1:4567', code: 'two' });
  release();
  await pending;
  assert.equal(actions.length, 0, 'old command must not execute for the newly paired work');
  assert.equal(bridge.status().workId, 'work2');
  assert.equal(s.state.connection.workId, 'work2');
});
test('re-pair while content injection awaits blocks the previously queued action', async () => {
  const s = await paired();
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  let delayed = false;
  let actions = 0;
  s.chrome.scripting.executeScript = async options => {
    if (options.files && !delayed) { delayed = true; started(); await new Promise(resolve => { release = resolve; }); }
    if (options.args?.[0] === 'click') actions++;
    return [{ documentId: 'document-test', result: { url: s.tab.url } }];
  };
  const pending = s.bridge.execute(command('click'));
  await waiting;
  await s.bridge.disconnect();
  await s.bridge.pair({ endpoint: 'http://127.0.0.1:4567', code: 'new' });
  release();
  await assert.rejects(pending, /connection|ownership/i);
  assert.equal(actions, 0);
});
test('expired commands reject before DOM execution or capture including delayed API completion', async () => {
  const s = await paired();
  let effects = 0;
  s.chrome.scripting.executeScript = async () => { effects++; return [{ documentId: 'document-test', result: {} }]; };
  s.chrome.tabs.captureVisibleTab = async () => { effects++; return 'data:image/png;base64,YQ=='; };
  for (const op of ['click', 'capture']) await assert.rejects(s.bridge.execute({ ...command(op), expiresAt: Date.now() - 1 }), /expir/i);
  await assert.rejects(s.bridge.execute({ ...command('click'), expiresAt: undefined }), /expir/i);
  const delayed = { ...command('click'), expiresAt: Date.now() + 5 };
  s.chrome.tabs.get = async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { ...s.tab }; };
  await assert.rejects(s.bridge.execute(delayed), /expir/i);
  assert.equal(effects, 0);
});
test('pair and disconnect clear previous DOM observations', async () => {
  const s = setup();
  const operations = [];
  s.chrome.scripting.executeScript = async options => { if (options.args) operations.push(options.args[0]); return [{ documentId: 'document-test', result: { url: s.tab.url } }]; };
  await s.bridge.pair({ endpoint: 'http://127.0.0.1:4567', code: 'one' });
  await s.bridge.disconnect();
  assert.deepEqual(operations, ['bind', 'revoke']);
});
test('server-revoked commands fail preflight before DOM actions and capture', async () => {
  const s = setup();
  const bridge = createBridge(s.chrome, async url => ({ ok: true, status: 200, json: async () => url.endsWith('/pair') ? { token: 'token', workId: 'work' } : { valid: false } }));
  await bridge.pair({ endpoint: 'http://127.0.0.1:4567', code: 'one' });
  let effects = 0;
  s.chrome.scripting.executeScript = async options => { if (options.args?.[0] === 'click') effects++; return [{ documentId: 'document-test', result: { url: s.tab.url } }]; };
  s.chrome.tabs.captureVisibleTab = async () => { effects++; return 'data:image/png;base64,YQ=='; };
  await assert.rejects(bridge.execute(command('click')), /valid|cancel|revok/i);
  await assert.rejects(bridge.execute(command('capture')), /valid|cancel|revok/i);
  assert.equal(effects, 0);
});
test('actual injected function observes a fresh same-origin document and pins its document ID', async () => {
  const { JSDOM } = require('jsdom');
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
  const s = setup();
  let documentId = 'document-one';
  let page = new JSDOM('<button>Save</button>', { url: s.tab.url, runScripts: 'outside-only' });
  const calls = [];
  s.chrome.scripting.executeScript = async options => {
    if (options.files) { page.window.eval(source); return [{ documentId }]; }
    calls.push(options);
    if (options.target.documentIds && options.target.documentIds[0] !== documentId) throw new Error('Document changed');
    page.window.__args = options.args;
    return [{ documentId, result: page.window.eval(`(${options.func.toString()})(...__args)`) }];
  };
  await s.bridge.pair({ endpoint: 'http://127.0.0.1:4567', code: 'one' });
  const initial = await s.bridge.execute(command('observe'));
  page.window.close();
  s.tab.url = 'https://example.test/new-document';
  documentId = 'document-two';
  page = new JSDOM('<button>New Save</button>', { url: s.tab.url, runScripts: 'outside-only' });
  const fresh = await s.bridge.execute(command('observe'));
  assert.equal(fresh.url, s.tab.url);
  assert.notEqual(fresh.observationId, initial.observationId);
  assert.deepEqual(calls.at(-1).target.documentIds, ['document-two']);
  await assert.rejects(s.bridge.execute({ ...command('click', { observationId: initial.observationId, elementId: initial.elements[0].id }), expectedUrl: s.tab.url }), /observation/);
  await s.bridge.execute({ ...command('click', { observationId: fresh.observationId, elementId: fresh.elements[0].id }), expectedUrl: s.tab.url });
  page.window.close();
});
test('redacted tab URL or missing tab access revokes the connection', async () => {
  for (const reason of ['redacted', 'closed']) {
    const s = await paired();
    if (reason === 'redacted') delete s.tab.url;
    else s.chrome.tabs.get = async () => { throw new Error('No tab'); };
    await assert.rejects(s.bridge.execute(command('observe')));
    assert.equal(s.bridge.status().connected, false, reason);
    assert.equal(s.state.connection, undefined);
  }
});
test('loading/completed events with redacted URL revoke even without change.url', async () => {
  const s = await paired();
  delete s.tab.url;
  await s.bridge.tabChanged(7, { status: 'complete' });
  assert.equal(s.bridge.status().connected, false);
});
