import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkStore } from '../src/work/store';
import { CodexService } from '../src/codex/codex.service';
import { DesktopLifecycle } from '../src/desktop/lifecycle';
import { desktopHealth } from '../src/desktop/health';

let app: INestApplication;
afterEach(async () => { await app?.close(); for (const key of ['CONFIG_PATH', 'DATA_DIR', 'DESKTOP_TOKEN', 'OPENSPEC_SAFE_MODE']) delete process.env[key]; });
async function setup(before?: (store: WorkStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-health-api-')); mkdirSync(join(dir, 'openspec'));
  process.env.CONFIG_PATH = join(dir, 'config.json'); process.env.DATA_DIR = join(dir, 'data'); process.env.DESKTOP_TOKEN = 'secret';
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(dir, 'openspec') }] }));
  if (before) { const store = new WorkStore(); before(store); store.onApplicationShutdown(); }
  app = await createApplication(); await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  return { store: app.get(WorkStore), call: (path: string, body?: unknown, token = 'secret') => fetch(`${base}/api/desktop/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'x-desktop-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }) };
}
function save(store: WorkStore, phase = 'planning', state = 'idle') {
  return store.save({ id: 'w', sourceId: 'demo', projectPath: '.', changeName: 'test', requestKey: 'w', ideaIds: [], phase, state, threadId: 'thread', reviewedVersion: null, createdAt: '', updatedAt: '' });
}
it('진단과 복구 API는 인증·입력 검증·종료 잠금을 유지한다', async () => {
  const { store, call } = await setup(); save(store, 'planning', 'recovery-required');
  desktopHealth(store).register('codex', () => 'inactive');
  expect((await call('diagnostics', undefined, '')).status).toBe(401);
  expect((await call('safe-mode', { enabled: 'yes' })).status).toBe(400);
  expect((await call('recover/w', {})).status).toBe(201);
  expect(store.get('w')?.state).toBe('interrupted');
  expect((await call('prepare', {})).status).toBe(201);
  expect((await call('safe-mode', { enabled: true })).status).toBe(409);
  expect((await call('recover/w', {})).status).toBe(409);
});
it('Codex 연결 해제는 완료되거나 유휴인 다른 대화를 변조하지 않는다', async () => {
  const { store } = await setup(); save(store, 'completed');
  const before = store.get('w');
  app.get(CodexService).client.emit('disconnected', 'raw secret error');
  expect(store.get('w')).toEqual(before);
  const diagnostics = app.get(DesktopLifecycle).diagnostics();
  expect(JSON.stringify(diagnostics)).not.toContain('raw secret error');
});
it('서버 시작도 이미 완료된 업무의 과거 상태를 변조하지 않는다', async () => {
  const { store } = await setup(store => {
    save(store, 'completed', 'running');
    store.record('browser', 'w', 'browser-verification', { status: 'running', owner: 'user' });
    store.record('verification', 'w', 'verification', { status: 'running' });
  });
  expect(store.get('w')?.state).toBe('running');
  expect(store.records('w', 'browser-verification')[0].status).toBe('running');
  expect(store.records('w', 'verification')[0].status).toBe('running');
});
it('안전 모드는 새 AI 요청을 막고 질문·초안·대기열을 보존한다', async () => {
  const { store, call } = await setup(); save(store);
  store.record('queued', 'w', 'queued-message', { status: 'queued', text: 'SECRET' });
  await call('safe-mode', { enabled: true });
  await expect(app.get(CodexService).send('w', 'SECRET')).rejects.toThrow('안전 모드');
  expect(store.records('w', 'queued-message')[0].status).toBe('queued');
  const diagnostics = await (await call('diagnostics')).json();
  expect(diagnostics.safeMode).toBe(true); expect(JSON.stringify(diagnostics)).not.toContain('SECRET');
  await call('safe-mode', { enabled: false });
  expect(store.records('w', 'queued-message')[0]).toMatchObject({ status: 'blocked', text: 'SECRET' });
});
