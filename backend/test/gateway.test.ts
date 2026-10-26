import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { INestApplication } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import { createApplication } from '../src/app';
import { createGateway } from '../src/gateway';

let engine: INestApplication, gateway: Server, port: number, base: string;
const request = async (path: string, body?: unknown) => {
  const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
const startGateway = async () => {
  gateway = createGateway(port); await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(gateway.address() as any).port}`;
};
const stopGateway = async () => { const stopped = new Promise<void>(resolve => gateway.close(() => resolve())); gateway.closeAllConnections(); await stopped; };
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-gateway-'));
  await mkdir(join(root, 'openspec', 'changes', 'test'), { recursive: true });
  await writeFile(join(root, 'openspec', 'changes', 'test', '.openspec.yaml'), 'schema: spec-driven\n');
  process.env.CONFIG_PATH = join(root, 'config.json'); process.env.DATA_DIR = join(root, 'data');
  process.env.CODEX_BIN = process.execPath; process.env.CODEX_ARGS = JSON.stringify([resolve('test/fixtures/codex.cjs')]);
  await writeFile(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: './openspec' }] }));
  engine = await createApplication(); await engine.listen(0, '127.0.0.1'); port = Number(new URL(await engine.getUrl()).port);
  await startGateway();
});
afterAll(async () => { if (gateway?.listening) await stopGateway(); await engine?.close(); for (const key of ['CONFIG_PATH','DATA_DIR','CODEX_BIN','CODEX_ARGS']) delete process.env[key]; });

it('웹 서버를 재시작해도 같은 대화의 질문과 응답 연결을 유지한다', async () => {
  const work = (await request('work', { sourceId: 'demo', changeName: 'test', requestKey: 'gateway' })).data;
  await request(`work/${work.id}/message`, { text: '질문 해줘' });
  await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('waiting-input');
  const before = (await request(`work/${work.id}`)).data, question = before.questions.find((q: any) => q.status === 'pending');
  await stopGateway(); await startGateway();
  const after = (await request(`work/${work.id}`)).data;
  expect(after).toMatchObject({ threadId: before.threadId, state: 'waiting-input' });
  expect(after.questions.find((q: any) => q.id === question.id)).toMatchObject({ requestId: question.requestId, status: 'pending', generation: question.generation });
  expect((await request(`work/${work.id}/answer`, { questionId: question.id, answers: { choice: { answers: ['동일 연결'] } } })).status).toBe(200);
  await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
});
it('실행 중 프록시 교체 후 같은 대화의 완료 이벤트를 다시 받는다', async () => {
  const work = (await request('work')).data.work[0];
  const previous = (await request(`work/${work.id}`)).data.events.at(-1).seq;
  await request(`work/${work.id}/message`, { text: '지연 응답' });
  await stopGateway(); await startGateway();
  await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
  const abort = new AbortController();
  const response = await fetch(`${base}/api/work/${work.id}/events?after=${previous}`, { signal: abort.signal });
  const reader = response.body!.getReader(); let text = '';
  try { while (!text.includes('turn/completed')) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); } } finally { abort.abort(); }
  expect(text).toContain('turn/completed');
  expect((await request(`work/${work.id}`)).data.threadId).toBe(work.threadId);
});
it('세션 서버가 없으면 재연결 가능한 503으로 응답한다', async () => {
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const unused = (reservation.address() as any).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const unavailable = createGateway(unused); await new Promise<void>(resolve => unavailable.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(unavailable.address() as any).port}/api/health`);
    expect(response.status).toBe(503); expect((await response.json()).message).toContain('저장된 업무는 유지');
  } finally { const closed = new Promise<void>(resolve => unavailable.close(() => resolve())); unavailable.closeAllConnections(); await closed; }
});
