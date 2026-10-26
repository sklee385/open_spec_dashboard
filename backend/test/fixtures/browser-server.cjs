const { createServer } = require('node:http');
const { writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const file = join(process.env.DATA_DIR, 'value.json');
let value = ''; try { value = JSON.parse(readFileSync(file, 'utf8')); } catch {}
const server = createServer(async (req, res) => {
  if (req.url === '/' && process.argv[3] === 'root-redirect') { res.writeHead(302, { Location: '/home' }); res.end(); return; }
  if (req.url === '/redirect' || req.url === '/redirect-local') { res.writeHead(302, { Location: req.url === '/redirect-local' ? '/redirect' : `http://127.0.0.1:${process.argv[2] || 14399}/private` }); res.end(); return; }
  if (req.url === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write('data: streamed\n\n'); return; }
  if (req.url === '/save' && req.method === 'POST') {
    let data = ''; for await (const chunk of req) data += chunk;
    value = data; writeFileSync(file, JSON.stringify(value)); res.end('ok'); return;
  }
  if (req.url === '/value') { res.end(value); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><h1>검증</h1><label>이름<input id="name"></label><button id="save">저장</button><p role="status" aria-label="결과"></p>
    ${req.url === '/ambiguous' ? '<button>저장</button>' : ''}
    ${req.url === '/external' ? '<img src="http://127.0.0.1:14399/private">' : ''}
    ${req.url === '/stream' ? '<p data-testid="stream"></p><p data-testid="socket"></p><script>new EventSource("/events").onmessage=e=>document.querySelector("[data-testid=stream]").textContent=e.data;new WebSocket("ws://"+location.host+"/ws").onmessage=e=>document.querySelector("[data-testid=socket]").textContent=e.data;</script>' : ''}
    <script>fetch('/value').then(r=>r.text()).then(v=>document.querySelector('input').value=v);
    document.querySelector('#save').onclick=async()=>{ await fetch('/save',{method:'POST',body:document.querySelector('input').value}); document.querySelector('p').textContent='저장됨'; };</script>`);
});
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const message = Buffer.from('socket ready'); socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message])); socket.on('error', () => {});
});
server.listen(Number(process.env.PORT), '127.0.0.1');
