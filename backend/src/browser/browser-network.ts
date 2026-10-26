import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { connect, type Socket } from 'node:net';
import { allowedRequest } from './browser-policy';

/** A streaming egress boundary; redirects must pass through it again. */
export async function browserNetwork(origin: string, denied: () => void) {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const address = new URL(origin);
  const allowed = (value: string) => allowedRequest(value.replace(/^ws:/, 'http:'), origin);
  const server = createServer((req, res) => {
    const value = req.url || '';
    if (!allowed(value)) { denied(); res.writeHead(403); res.end(); return; }
    const target = new URL(value);
    const headers: IncomingHttpHeaders = { ...req.headers, host: address.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const upstream = request({ hostname: '127.0.0.1', port: address.port, path: target.pathname + target.search, method: req.method, headers, agent: false }, response => {
      res.writeHead(response.statusCode || 502, response.headers); res.flushHeaders(); response.pipe(res);
    });
    upstream.on('socket', track); upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.once('close', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('connection', track);
  server.on('connect', (req, socket, head) => {
    // Chromium also tunnels ws:// through CONNECT. Pin the destination; never
    // resolve a hostname or accept a second address supplied inside the tunnel.
    if (req.url !== address.host) { denied(); socket.destroy(); return; }
    const upstream = track(connect(Number(address.port), '127.0.0.1'));
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy());
  });
  server.on('upgrade', (req, socket, head) => {
    if (!allowed(req.url || '')) { denied(); socket.destroy(); return; }
    const target = new URL(req.url!), upstream = track(connect(Number(address.port), '127.0.0.1'));
    upstream.once('connect', () => {
      const headers: IncomingHttpHeaders = { ...req.headers, host: address.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
      upstream.write(`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy());
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  return { proxy: { server: `http://127.0.0.1:${port}`, bypass: '<-loopback>' }, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
