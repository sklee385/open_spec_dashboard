import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
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
