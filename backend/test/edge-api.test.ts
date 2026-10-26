import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkStore, type Work } from '../src/work/store';
let app: INestApplication, base: string, store: WorkStore;
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'edge-api-')); await mkdir(join(root, 'openspec'), { recursive: true });
  process.env.CONFIG_PATH = join(root, 'config.json'); process.env.DATA_DIR = join(root, 'data');
  await writeFile(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'test', path: './openspec' }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl(); store = app.get(WorkStore);
  store.save({ id: 'new', sourceId: 'test', projectPath: root, changeName: 'new', requestKey: 'new', ideaIds: [], phase: 'planning', state: 'idle', threadId: null, reviewedVersion: null, createdAt: '', updatedAt: '' });
  store.save({ ...store.get('new')!, id: 'old', requestKey: 'old', changeName: 'old', threadId: 'existing' } as Work);
});
afterAll(async () => { await app?.close(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; });
it('새 업무와 기존 대화의 Edge 지원을 구분한다', async () => {
  const response = await fetch(`${base}/api/work/new/browser/edge`); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ supported: true, connected: false });
  const old = await fetch(`${base}/api/work/old/browser/edge`); expect(await old.json()).toMatchObject({ supported: false });
  expect((await fetch(`${base}/api/work/old/browser/edge/pair`, { method: 'POST' })).status).toBe(409);
  expect(store.get('old')?.threadId).toBe('existing');
});
it('실제 연결과 해제·확장 경로를 조회하고 없는 업무는 거절한다', async () => {
  expect((await fetch(`${base}/api/work/missing/browser/edge`)).status).toBe(404);
  const response = await fetch(`${base}/api/work/new/browser/edge/pair`, { method: 'POST' }); expect(response.status).toBe(200);
  const pair = await response.json(); expect(pair.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  const connected = await fetch(pair.endpoint + '/pair', { method: 'POST', body: JSON.stringify({ code: pair.code, url: 'http://localhost:13001/', title: 'Board', tabId: 3 }) }); expect(connected.status).toBe(200);
  expect(await (await fetch(`${base}/api/work/new/browser/edge`)).json()).toMatchObject({ connected: true, title: 'Board' });
  const settings = await (await fetch(`${base}/api/browser/edge/status`)).json(); expect(settings.extensionPath).toContain('edge-extension'); expect(settings.connections).toHaveLength(1);
  expect((await fetch(`${base}/api/work/new/browser/edge`, { method: 'DELETE' })).status).toBe(200);
  expect(await (await fetch(`${base}/api/work/new/browser/edge`)).json()).toMatchObject({ connected: false });
});
