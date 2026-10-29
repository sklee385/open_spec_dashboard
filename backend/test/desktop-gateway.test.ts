import { afterEach, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGateway } from '../src/gateway';
const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } });
async function start(s: Server) { servers.push(s); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); return Number((s.address() as any).port); }
it('정적 화면과 API는 앱 인증으로 보호하고 프록시는 인증을 전달한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-web-')); writeFileSync(join(root, 'index.html'), '<main>app</main>');
  const upstream = await start(createServer((req, res) => { res.end(req.headers['x-desktop-token'] === 'secret' ? 'ok' : 'bad'); }));
  const port = await start(createGateway(upstream, root, { staticDirectory: root, token: 'secret' }));
  const base = `http://127.0.0.1:${port}`;
  expect((await fetch(base)).status).toBe(401);
  expect(await (await fetch(base, { headers: { 'x-desktop-token': 'secret' } })).text()).toContain('<main>app</main>');
  expect(await (await fetch(`${base}/api/health`, { headers: { 'x-desktop-token': 'secret' } })).text()).toBe('ok');
  expect((await fetch(`${base}/%2e%2e%2foutside`, { headers: { 'x-desktop-token': 'secret' } })).status).toBe(403);
  expect((await fetch(base, { headers: { 'x-desktop-token': 'secret', Origin: 'https://evil.test' } })).status).toBe(403);
});

it('종료되는 upstream 연결을 재사용하지 않고 GET과 POST를 각각 한 번 전달한다', async () => {
  const seen = new WeakSet<object>();
  let reads = 0, writes = 0;
  const upstream = await start(createServer((req, res) => {
    // A peer can close an idle connection as the client starts reusing it.
    // Reject reused connections at the peer so this HTTP regression is deterministic.
    if (seen.has(req.socket)) { req.socket.destroy(); return; }
    seen.add(req.socket);
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST') writes++; else reads++;
      res.end('ok');
    });
  }));
  const port = await start(createGateway(upstream));
  const url = `http://127.0.0.1:${port}/api/probe`;
  const statuses = [];
  for (const method of ['GET', 'GET', 'POST']) {
    const response = await fetch(url, { method, body: method === 'POST' ? 'one write' : undefined });
    await response.text();
    statuses.push(response.status);
  }
  expect(statuses).toEqual([200, 200, 200]);
  expect({ reads, writes }).toEqual({ reads: 2, writes: 1 });
});

it('브라우저 요청이 취소되면 응답 대기 중인 upstream 연결도 종료한다', async () => {
  let upstreamClosed = false;
  let received!: () => void;
  const incoming = new Promise<void>(resolve => { received = resolve; });
  const upstream = await start(createServer((_req, res) => {
    res.once('close', () => { upstreamClosed = true; });
    received();
    // Keep the response pending until the downstream client cancels it.
  }));
  const port = await start(createGateway(upstream));
  const client = request({ hostname: '127.0.0.1', port, path: '/api/pending' });
  client.on('error', () => {}); // Destroying a pending request intentionally emits ECONNRESET.
  try {
    client.end();
    await incoming;
    expect(upstreamClosed).toBe(false);
    client.destroy();
    await expect.poll(() => upstreamClosed).toBe(true);
  } finally { client.destroy(); }
});
