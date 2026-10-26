const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
async function setup() {
  assert.ok(fs.existsSync(path.join(__dirname, '../popup.js')), 'Popup implementation must exist');
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../popup.html'), 'utf8'), { runScripts: 'outside-only' });
  const messages = [];
  dom.window.chrome = { runtime: { sendMessage: async message => {
    messages.push(message);
    return { ok: true, result: message.type === 'pair' ? { connected: true, title: '<script>inert</script>', url: 'https://example.test', workId: 'work' } : { connected: false } };
  } } };
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../popup.js'), 'utf8'));
  await new Promise(resolve => setImmediate(resolve));
  return { dom, messages, doc: dom.window.document };
}
test('popup only pairs after explicit form submission and renders server text safely', async () => {
  const { dom, messages, doc } = await setup();
  assert.deepEqual(messages.map(m => m.type), ['status']);
  doc.querySelector('#endpoint').value = 'http://127.0.0.1:4567';
  doc.querySelector('#code').value = '123456';
  doc.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages[1].type, 'pair');
  assert.equal(messages[1].code, '123456');
  assert.equal(doc.querySelector('#code').value, '');
  assert.equal(doc.querySelector('#status script'), null);
  assert.equal(doc.querySelector('#disconnect').hidden, false);
  doc.querySelector('#disconnect').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.at(-1).type, 'disconnect');
  assert.equal(doc.querySelector('form').hidden, false);
});
test('manifest limits site permission to loopback and grants selected-tab access only', () => {
  const manifest = require('../manifest.json');
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(!manifest.permissions.includes('tabs'));
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});
test('popup displays expired-code errors and permits a later reconnect attempt', async () => {
  const { dom, doc } = await setup();
  dom.window.chrome.runtime.sendMessage = async () => ({ ok: false, error: 'Pairing failed (401)' });
  doc.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(doc.querySelector('#status').textContent, /401/);
  assert.equal(doc.querySelector('#pair').disabled, false);
  assert.equal(doc.querySelector('form').hidden, false);
});
