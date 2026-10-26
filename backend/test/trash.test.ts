import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/gateway';

let engine: Server, gateway: Server, base: string, directory: string, port: number;
let state = 'idle';
const start = async () => {
  gateway = createGateway(port, directory);
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(gateway.address() as any).port}`;
};
const stop = async (server: Server) => { const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed; };
const post = (path: string, body: unknown) => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'board-trash-'));
  engine = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const data = req.url === '/api/changes' ? { changes: [{ id: 'demo/draft', name: 'draft', status: 'draft', title: '초안' }, { id: 'demo/todo', name: 'todo', status: 'todo' }] }
      : req.url === '/api/ideas' ? { ideas: [{ id: 'demo/idea', title: '아이디어' }] }
      : { work: [{ id: 'work-1', sourceId: 'demo', changeName: 'draft', state, threadId: 'original-thread', ideaIds: [] }] };
    res.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => engine.listen(0, '127.0.0.1', resolve)); port = (engine.address() as any).port;
  await start();
});
afterAll(async () => { await stop(gateway); await stop(engine); });

it('초안·할 일·아이디어를 삭제하고 재시작 후 복원해도 원본 세션을 보존한다', async () => {
  for (const entry of [{ kind: 'change', id: 'demo/draft' }, { kind: 'change', id: 'demo/todo' }, { kind: 'idea', id: 'demo/idea' }]) expect((await post('trash', entry)).status).toBe(200);
  expect(JSON.parse(await readFile(join(directory, 'board-trash.json'), 'utf8'))).toHaveLength(3);
  await stop(gateway); await start();
  expect((await (await fetch(`${base}/api/trash`)).json()).entries).toHaveLength(3);
  expect((await post('work/work-1/message', { text: 'stale tab' })).status).toBe(409);
  expect((await post('work', { sourceId: 'demo', changeName: 'draft', requestKey: 'stale' })).status).toBe(409);
  expect((await post('work', { sourceId: 'demo', changeName: 'new', ideaId: 'demo/idea', requestKey: 'stale-idea' })).status).toBe(409);
  expect((await post('trash/restore', { kind: 'change', id: 'demo/draft' })).status).toBe(200);
  expect((await (await fetch(`${base}/api/work`)).json()).work[0].threadId).toBe('original-thread');
});
it.each(['running','connecting','creating-thread','waiting-input','waiting-approval'])('%s인 업무는 삭제하지 않는다', async active => {
  state = active;
  expect((await post('trash', { kind: 'change', id: 'demo/draft' })).status).toBe(409);
  expect((await (await fetch(`${base}/api/trash`)).json()).entries.some((entry: any) => entry.id === 'demo/draft')).toBe(false);
  state = 'idle';
});
it('존재하지 않는 항목과 외부 Origin의 삭제를 거절한다', async () => {
  expect((await post('trash', { kind: 'change', id: 'demo/missing' })).status).toBe(404);
  expect((await fetch(`${base}/api/trash`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
});
