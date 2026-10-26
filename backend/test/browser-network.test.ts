import { expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import { browserNetwork } from '../src/browser/browser-network';

it('SSE의 첫 데이터가 없어도 응답 헤더를 즉시 전달한다', async () => {
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const network = await browserNetwork(origin, () => {}), proxy = new URL(network.proxy.server);
  let timer: NodeJS.Timeout, responseCode: number | undefined;
  const incoming = request({ hostname: proxy.hostname, port: proxy.port, path: `${origin}/events` });
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => { incoming.once('response', response => { responseCode = response.statusCode; response.resume(); resolve(); }); incoming.once('error', reject); incoming.end(); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SSE 헤더가 전달되지 않았습니다')), 1000); }),
    ]);
    expect(responseCode).toBe(200);
  } finally { clearTimeout(timer!); incoming.destroy(); await network.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
