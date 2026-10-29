const fs = require('node:fs');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const LIMIT = 8 * 1024 * 1024;
function validKey(key) { return typeof key === 'string' && key.length <= 2048 && /^(work-chat-draft|work-view|work-draft|project-draft|project-view):[^\x00-\x1f]+$/.test(key); }
class DraftStore {
  constructor(directory) { this.directory = directory; this.path = join(directory, 'recovery-drafts.json'); }
  load() {
    if (this.values) return this.values;
    try {
      if (fs.statSync(this.path).size > LIMIT) throw Error('limit');
      const value = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (!value || Array.isArray(value) || typeof value !== 'object' || Object.entries(value).some(([key, text]) => !validKey(key) || typeof text !== 'string')) throw Error('shape');
      return this.values = value;
    } catch (error) { if (error.code === 'ENOENT') return this.values = {}; throw Error('초안 저장 파일을 읽지 못했습니다. 파일을 보존하고 저장을 중단합니다.'); }
  }
  request(operation, key, value) {
    if (!validKey(key)) throw Error('허용되지 않은 초안 키입니다');
    const values = this.load();
    if (operation === 'get') return Object.hasOwn(values, key) ? values[key] : null;
    if (!['set','remove'].includes(operation) || operation === 'set' && (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > LIMIT)) throw Error('초안 요청이 잘못되었습니다');
    const next = { ...values };
    if (operation === 'set') next[key] = value; else delete next[key];
    const json = JSON.stringify(next);
    if (Buffer.byteLength(json, 'utf8') > LIMIT) throw Error('초안 저장 용량을 초과했습니다');
    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    try { fs.writeFileSync(temporary, json, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.path); this.values = next; }
    catch { throw Error('초안을 저장하지 못했습니다. 입력 화면을 유지해 주세요.'); }
    finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
    return null;
  }
}
function registerDraftBridge({ ipcMain, window, origin, store }) {
  const listener = (event, operation, key, value) => {
    try {
      const contents = window.webContents;
      if (window.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw Error('허용되지 않은 초안 요청입니다');
      event.returnValue = { ok: true, value: store.request(operation, key, value) };
    } catch (error) { event.returnValue = { ok: false, error: error.message }; }
  };
  ipcMain.on('desktop:draft', listener);
  return () => ipcMain.removeListener('desktop:draft', listener);
}
module.exports = { DraftStore, registerDraftBridge };
