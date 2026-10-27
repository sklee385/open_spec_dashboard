import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkStore } from '../src/work/store';

let app: INestApplication | undefined;
afterEach(async () => { await app?.close(); app = undefined; for (const k of ['DATA_DIR','CONFIG_PATH','DESKTOP_TOKEN']) delete process.env[k]; });
async function setup(attach?: (application: INestApplication) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-lifecycle-'));
  process.env.DATA_DIR = join(dir, 'data'); process.env.CONFIG_PATH = join(dir, 'config.json'); process.env.DESKTOP_TOKEN = 'test-desktop-secret';
  mkdirSync(join(dir, 'openspec'));
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'empty', path: join(dir, 'openspec') }] }));
  app = await createApplication(); attach?.(app); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const call = (path: string, method = 'GET', token = 'test-desktop-secret') => fetch(`${base}/api/${path}`, { method, headers: { 'x-desktop-token': token } });
  return { call, store: app.get(WorkStore), base };
}
function work(store: WorkStore, state: string) {
  return store.save({ id: 'one', sourceId: 'source', projectPath: '/test', changeName: 'test', requestKey: 'one', ideaIds: [], phase: 'planning', state, threadId: null, reviewedVersion: null, createdAt: '', updatedAt: '' });
}
it('데스크톱 API와 스트리밍 접근은 비밀 인증이 필요하다', async () => {
  const { call } = await setup();
  expect((await call('health', 'GET', '')).status).toBe(401);
  expect((await call('health', 'GET', 'wrong-desktop-secret')).status).toBe(401);
  expect((await call('events', 'GET', '')).status).toBe(401);
  expect((await call('health')).status).toBe(200);
});
it.each(['running','connecting','creating-thread','waiting-input','waiting-approval','recovery-required'])('%s 상태에서는 종료 잠금을 잡지 않는다', async state => {
  const { call, store } = await setup(); work(store, state);
  expect((await call('desktop/prepare', 'POST')).status).toBe(409);
});
it('idle이어도 미답변 질문과 자동 전송 대기열이 있으면 종료하지 않는다', async () => {
  const { call, store } = await setup(); work(store, 'idle');
  store.record('q', 'one', 'question', { kind: 'input', status: 'pending' });
  expect((await call('desktop/prepare', 'POST')).status).toBe(409);
  store.record('q', 'one', 'question', { kind: 'input', status: 'answered' });
  store.record('queued', 'one', 'queued-message', { status: 'queued' });
  expect((await call('desktop/prepare', 'POST')).status).toBe(409);
});
it('유휴 상태 전환 후 새로운 실행 요청을 차단하고 취소하면 다시 받는다', async () => {
  const { call, store } = await setup(); work(store, 'idle');
  expect((await call('desktop/prepare', 'POST')).status).toBe(201);
  expect((await call('work', 'POST')).status).toBe(503);
  expect((await call('desktop/cancel', 'POST')).status).toBe(201);
  expect((await call('work', 'POST')).status).not.toBe(503);
});
it('처리 중인 변경 요청은 설치 전환을 막고 잠금 뒤 새 SSE도 거절한다', async () => {
  // Add a real delayed HTTP request after the same lifecycle middleware; no state-counter stubs.
  let release!: () => void, entered!: () => void;
  const accepted = new Promise<void>(resolve => { entered = resolve; });
  const complete = new Promise<void>(resolve => { release = resolve; });
  const { call, base } = await setup(application => application.getHttpAdapter().getInstance().post('/api/fixture-delay', async (_req: any, res: any) => { entered(); await complete; res.json({ ok: true }); }));
  const pending = fetch(`${base}/api/fixture-delay`, { method: 'POST', headers: { 'x-desktop-token': 'test-desktop-secret' } });
  await accepted;
  expect((await call('desktop/prepare', 'POST')).status).toBe(409);
  release(); await pending;
  expect((await call('desktop/prepare', 'POST')).status).toBe(201);
  expect((await call('events')).status).toBe(503);
});
