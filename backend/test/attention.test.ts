import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { createApplication } from '../src/app';
import { WorkStore, type Work } from '../src/work/store';
import { createGateway } from '../src/gateway';

let app: INestApplication, gateway: Server, store: WorkStore, base: string;
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'attention-'));
  for (const name of ['alpha', 'beta']) mkdirSync(join(root, 'openspec/changes', name), { recursive: true });
  process.env.CONFIG_PATH = join(root, 'config.json'); process.env.DATA_DIR = join(root, 'data');
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: './openspec' }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); store = app.get(WorkStore);
  gateway = createGateway(Number(new URL(await app.getUrl()).port));
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  for (const [id, changeName] of [['w1', 'alpha'], ['w2', 'beta']]) {
    store.save({ id, changeName, sourceId: 'demo', projectPath: root, requestKey: id, ideaIds: [], phase: 'planning', state: 'idle', threadId: null, reviewedVersion: null, createdAt: '2026-10-25', updatedAt: '2026-10-25' } as Work);
  }
  store.event('w1', 'source-idea', { title: '질문 알림', description: 'private' });
  for (const [id, workId, kind, status, createdAt] of [
    ['q1', 'w1', 'input', 'pending', '2026-10-25T01:00:00Z'],
    ['q2', 'w2', 'approval', 'pending', '2026-10-25T02:00:00Z'],
    ['q3', 'w1', 'approval', 'pending', '2026-10-25T02:00:00Z'],
    ...['sending', 'recovering', 'uncertain', 'answered', 'expired'].map(status => [status, 'w1', 'input', status, '2026-10-25T03:00:00Z']),
  ]) store.record(id, workId, 'question', { kind, status, createdAt, params: { questions: [{ question: 'secret' }, { question: 'private' }], command: 'secret-command', cwd: 'private-path' } });
});
afterAll(async () => {
  if (gateway) { const closed = new Promise<void>(resolve => gateway.close(() => resolve())); gateway.closeAllConnections(); await closed; }
  await app?.close(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR;
});

it('업무 상태와 무관하게 pending 요청만 한 건씩 요약하고 안정적으로 정렬한다', () => {
  expect(store.attention()).toEqual([
    { workId: 'w2', sourceId: 'demo', changeName: 'beta', title: 'beta', questionId: 'q2', kind: 'approval', status: 'pending', createdAt: '2026-10-25T02:00:00Z' },
    { workId: 'w1', sourceId: 'demo', changeName: 'alpha', title: '질문 알림', questionId: 'q3', kind: 'approval', status: 'pending', createdAt: '2026-10-25T02:00:00Z' },
    { workId: 'w1', sourceId: 'demo', changeName: 'alpha', title: '질문 알림', questionId: 'q1', kind: 'input', status: 'pending', createdAt: '2026-10-25T01:00:00Z' },
  ]);
});
it('게이트웨이 경유 정적 API는 :id와 충돌하지 않고 비공개 인자를 노출하지 않는다', async () => {
  const response = await fetch(`${base}/api/work/attention`);
  expect(response.status).toBe(200);
  const data = await response.json(); expect(data.items).toEqual(store.attention());
  expect(JSON.stringify(data)).not.toMatch(/secret|private|projectPath|params/);
  store.record('q2', 'w2', 'question', { kind: 'approval', status: 'answered' });
  const updated = await (await fetch(`${base}/api/work/attention`)).json();
  expect(updated.items.map((item: any) => item.questionId)).toEqual(['q3', 'q1']);
});
it('설정 API는 저장 의도와 실제 활성화를 구분하고 조회로 꺼짐을 바꾸지 않는다', async () => {
  const initial = await (await fetch(`${base}/api/notifications/settings`)).json();
  expect(initial).toMatchObject({ enabled: true, effectiveEnabled: false, registrationStatus: 'unsupported' });
  const put = (body: unknown) => fetch(`${base}/api/notifications/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect((await put({ enabled: false, dashboardUrl: 'http://localhost:14101/' })).status).toBe(200);
  expect(await (await fetch(`${base}/api/notifications/settings`)).json()).toMatchObject({ enabled: false, effectiveEnabled: false, dashboardUrl: 'http://localhost:14101/' });
  expect((await put({ effectiveEnabled: true })).status).toBe(400);
  expect((await put({ dashboardUrl: 'https://external.example/' })).status).toBe(400);
  expect(await (await fetch(`${base}/api/notifications/settings`)).json()).toMatchObject({ enabled: false, registrationStatus: 'disabled' });
});
