import { createServer, request } from 'node:http';
import { BoardTrash } from './trash';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

export interface DesktopGatewayOptions { staticDirectory?: string; token?: string; gate?: { locked: boolean; pending: number }; }

/** A disposable web process: session ownership stays in the independent API process. */
export function createGateway(targetPort = 13003, trashDirectory?: string, options: DesktopGatewayOptions = {}) {
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error('잘못된 세션 서버 포트입니다');
  let pendingCommands = 0;
  const trash = new BoardTrash(targetPort, trashDirectory, () => pendingCommands, options.token);
  return createServer(async (req, res) => {
    if (options.token) {
      const expected = Buffer.from(options.token), provided = Buffer.from(typeof req.headers['x-desktop-token'] === 'string' ? req.headers['x-desktop-token'] : '');
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) { res.writeHead(401); res.end(); return; }
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end(); return; }
    }
    if (!['GET','HEAD','OPTIONS'].includes(req.method || 'GET') && options.gate) {
      if (options.gate.locked) { res.writeHead(503); res.end('앱 종료·업데이트 준비 중입니다'); return; }
      options.gate.pending++;
      let finished = false;
      const done = () => { if (!finished) { finished = true; options.gate!.pending--; } };
      res.once('finish', done); res.once('close', done);
    }
    if (options.staticDirectory && !req.url?.startsWith('/api/')) {
      try {
        if (!['GET','HEAD'].includes(req.method || '')) { res.writeHead(405); res.end(); return; }
        const path = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
        const root = realpathSync(options.staticDirectory);
        let target = resolve(root, `.${path === '/' ? '/index.html' : path}`);
        const inside = (file: string) => { const rel = relative(root, file); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
        if (!inside(target)) { res.writeHead(403); res.end(); return; }
        if (!existsSync(target) && !extname(path)) target = resolve(root, 'index.html');
        if (!existsSync(target) || !statSync(target).isFile()) { res.writeHead(404); res.end(); return; }
        if (!inside(realpathSync(target))) { res.writeHead(403); res.end(); return; }
        const types: Record<string,string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
        res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : readFileSync(target)); return;
      } catch { res.writeHead(400); res.end(); return; }
    }
    if (req.url === '/api/runtime/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ role: 'gateway', sessionPort: targetPort })); return;
    }
    if (await trash.handle(req, res)) return;
    if (req.method !== 'GET' && /^\/api\/(work|ideas)(\/|$)/.test(req.url || '')) {
      pendingCommands++;
      let finished = false;
      const done = () => { if (!finished) { finished = true; pendingCommands--; } };
      res.once('finish', done); res.once('close', done);
    }
    const upstream = request({ hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } }, response => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
      res.end(JSON.stringify({ message: '대화 서버에 연결하는 중입니다. 저장된 업무는 유지됩니다. 잠시 후 다시 시도해 주세요.' }));
    });
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('error', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    const body = (req as typeof req & { boardBody?: Buffer }).boardBody;
    if (body) upstream.end(body); else req.pipe(upstream);
  });
}
