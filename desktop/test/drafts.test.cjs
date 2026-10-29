const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), { join } = require('node:path'), { tmpdir } = require('node:os');
const { DraftStore, registerDraftBridge } = require('../drafts.cjs');
test('초안은 임의 서버 포트와 무관하게 프로필에 저장되고 삭제·재시작을 견딘다', t => {
  const directory = fs.mkdtempSync(join(tmpdir(),'desktop-drafts-')); t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const a = new DraftStore(directory); a.request('set','work-chat-draft:work1','private draft');
  const b = new DraftStore(directory); assert.equal(b.request('get','work-chat-draft:work1'),'private draft');
  b.request('remove','work-chat-draft:work1'); assert.equal(new DraftStore(directory).request('get','work-chat-draft:work1'),null);
  for (const key of ['../config.json','__proto__','token','work-draft:\n','project-operation:x']) assert.throws(() => b.request('set',key,'x'));
});
test('잘못된 저장 파일과 용량 초과 요청은 기존 파일을 덮어쓰지 않는다', t => {
  const directory = fs.mkdtempSync(join(tmpdir(),'desktop-drafts-')); t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const store = new DraftStore(directory); store.request('set','work-draft:w','keep');
  assert.throws(() => store.request('set','work-draft:w','x'.repeat(8*1024*1024)),/용량/);
  assert.equal(new DraftStore(directory).request('get','work-draft:w'),'keep');
  fs.writeFileSync(store.path,'{'); assert.throws(() => new DraftStore(directory).request('set','work-draft:w','replace'),/보존/);
  assert.equal(fs.readFileSync(store.path,'utf8'),'{');
});
test('초안 IPC는 현재 소유 창의 정확한 프레임과 앱 origin만 허용한다', () => {
  let listener; const content = { mainFrame: { url:'http://127.0.0.1:12345/' } }, store = { request: (...args) => args.join('|') };
  const off = registerDraftBridge({ipcMain:{on: (channel,fn) => { assert.equal(channel,'desktop:draft'); listener=fn; },removeListener: (channel,fn) => assert.equal(fn,listener)},window:{webContents:content,isDestroyed:()=>false},origin:'http://127.0.0.1:12345',store});
  const good = {sender:content,senderFrame:content.mainFrame}; listener(good,'get','work-draft:w'); assert.equal(good.returnValue.ok,true);
  for (const event of [{sender:{},senderFrame:content.mainFrame},{sender:content,senderFrame:{url:content.mainFrame.url}}]) { listener(event,'get','work-draft:w'); assert.equal(event.returnValue.ok,false); }
  content.mainFrame.url='https://example.com'; listener(good,'get','work-draft:w'); assert.equal(good.returnValue.ok,false); off();
});
