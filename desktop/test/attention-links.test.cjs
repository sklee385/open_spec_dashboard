const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAttentionURI, launchFromArgv, AttentionRouter, registerAttentionProtocol, trustedAttentionSender } = require('../attention-links.cjs');
test('only exact application attention links with two bounded identifiers are accepted', () => {
  assert.deepEqual(parseAttentionURI('openspecboard://attention?workId=w%26x&questionId=q%23y'), { workId: 'w&x', questionId: 'q#y' });
  for (const input of ['https://localhost/?workId=w&questionId=q','openspecboard://other?workId=w&questionId=q','openspecboard://attention/path?workId=w&questionId=q','openspecboard://user@attention?workId=w&questionId=q','openspecboard://attention?workId=w','openspecboard://attention?workId=w&questionId=q&command=run','openspecboard://attention?workId=w&workId=x&questionId=q','openspecboard://attention?workId=%00&questionId=q','openspecboard://attention?workId=w&questionId=q#hash']) assert.throws(() => parseAttentionURI(input));
  assert.equal(launchFromArgv(['app.exe']), null);
  assert.deepEqual(launchFromArgv(['app.exe','openspecboard://invalid']), { invalid: true });
});
test('cold launch goes through initial URL before recent work restoration; later clicks wait for renderer readiness', () => {
  const delivered = []; let shows = 0; const router = new AttentionRouter({ send: target => delivered.push(target), show: () => { shows++; } });
  router.accept(['app.exe','openspecboard://attention?workId=w&questionId=q']);
  assert.equal(router.initialURL('http://127.0.0.1:4567'), 'http://127.0.0.1:4567/?workId=w&questionId=q'); assert.equal(delivered.length, 0);
  router.accept(['app.exe','openspecboard://attention?workId=w2&questionId=q2']); assert.equal(delivered.length, 0);
  router.ready(); assert.deepEqual(delivered, [{ workId: 'w2', questionId: 'q2' }]);
  router.accept(['app.exe','openspecboard://attention?workId=w3&questionId=q3']); assert.equal(delivered.length, 2); assert.equal(shows, 3);
  router.reset(); router.accept(['app.exe','openspecboard://attention?workId=w4&questionId=q4']); assert.equal(delivered.length, 2); router.ready(); assert.equal(delivered.length, 3);
});
test('invalid cold links suppress recent restoration, and only trusted dashboard main frame can signal readiness', () => {
  const router = new AttentionRouter({ send() {}, show() {} }); router.accept(['app.exe','openspecboard://bad']);
  assert.match(router.initialURL('http://127.0.0.1:4567'), /workId=&questionId=/); assert.throws(() => router.initialURL('https://evil.example/'));
  const frame = { url: 'http://127.0.0.1:4567/' }, contents = { mainFrame: frame }, window = { webContents: contents, isDestroyed: () => false };
  assert.equal(trustedAttentionSender({ sender: contents, senderFrame: frame }, window, 'http://127.0.0.1:4567'), true);
  assert.equal(trustedAttentionSender({ sender: contents, senderFrame: { url: frame.url } }, window, 'http://127.0.0.1:4567'), false);
  frame.url = 'https://evil.example/'; assert.equal(trustedAttentionSender({ sender: contents, senderFrame: frame }, window, 'http://127.0.0.1:4567'), false);
});
test('protocol registration uses only the current application executable and entry; smoke does not change registration', () => {
  const calls = [], app = { setAsDefaultProtocolClient: (...args) => { calls.push(args); return true; }, isDefaultProtocolClient: () => true };
  assert.equal(registerAttentionProtocol(app, 'app.exe', null, false), true); assert.deepEqual(calls[0], ['openspecboard']);
  assert.equal(registerAttentionProtocol(app, 'electron.exe', __filename, false), true); assert.equal(calls[1][0], 'openspecboard'); assert.equal(calls[1][1], 'electron.exe'); assert.deepEqual(calls[1][2], [__filename]);
  assert.equal(registerAttentionProtocol(app, 'app.exe', null, true), false); assert.equal(calls.length, 2);
  assert.equal(registerAttentionProtocol({ setAsDefaultProtocolClient() { throw new Error('denied'); } }, 'app.exe'), false);
  assert.equal(registerAttentionProtocol({ setAsDefaultProtocolClient: () => true, isDefaultProtocolClient: () => false }, 'app.exe'), false);
});
