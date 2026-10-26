const { resolve } = require('node:path');
const SCHEME = 'openspecboard';
function parseAttentionURI(input) {
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x20\x7f]/.test(input)) throw new Error('Invalid notification link');
  const url = new URL(input);
  if (url.protocol !== `${SCHEME}:` || url.hostname !== 'attention' || !['', '/'].includes(url.pathname) || url.username || url.password || url.port || url.hash) throw new Error('Invalid notification link');
  const keys = ['workId', 'questionId'];
  if ([...url.searchParams.keys()].some(key => !keys.includes(key)) || keys.some(key => {
    const value = url.searchParams.get(key); return url.searchParams.getAll(key).length !== 1 || !value?.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value);
  })) throw new Error('Invalid notification target');
  return { workId: url.searchParams.get('workId'), questionId: url.searchParams.get('questionId') };
}
function launchFromArgv(argv = []) {
  const links = argv.filter(arg => typeof arg === 'string' && /^openspecboard:/i.test(arg));
  if (!links.length) return null;
  try { if (links.length !== 1) throw new Error(); return parseAttentionURI(links[0]); } catch { return { invalid: true }; }
}
class AttentionRouter {
  constructor({ send, show }) { this.send = send; this.show = show; this.pending = null; this.isReady = false; }
  accept(argv) { const target = launchFromArgv(argv); if (!target) return false; this.pending = target; this.show(); this.flush(); return true; }
  initialURL(origin) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Invalid internal origin');
    if (this.pending) {
      url.searchParams.set('workId', this.pending.invalid ? '' : this.pending.workId); url.searchParams.set('questionId', this.pending.invalid ? '' : this.pending.questionId); this.pending = null;
    }
    return url.href;
  }
  ready() { this.isReady = true; this.flush(); }
  reset() { this.isReady = false; }
  flush() { if (this.isReady && this.pending) { this.send(this.pending); this.pending = null; } }
}
function registerAttentionProtocol(app, executable, entry, smoke = false) {
  if (smoke) return false;
  try {
    const args = entry ? [SCHEME, executable, [resolve(entry)]] : [SCHEME];
    return app.setAsDefaultProtocolClient(...args) && app.isDefaultProtocolClient(...args);
  } catch { return false; }
}
function trustedAttentionSender(event, window, origin) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  try { const url = new URL(event.senderFrame.url); return url.origin === origin && url.pathname === '/'; } catch { return false; }
}
module.exports = { SCHEME, parseAttentionURI, launchFromArgv, AttentionRouter, registerAttentionProtocol, trustedAttentionSender };
