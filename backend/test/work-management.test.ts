import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkStore } from '../src/work/store';
import { desktopHealth } from '../src/desktop/health';
import { DesktopLifecycle } from '../src/desktop/lifecycle';

let app: INestApplication, base: string, store: WorkStore, original: string;
const request = async (url = 'work/w/management', body?: any) => { const res = await fetch(`${base}/api/${url}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: res.status, data: await res.json() }; };
const submission = (current: any, state: string, key: string) => ({ scope: current.scope, runId: current.runId, state, reason: 'Synthetic administrative review', expectedVersion: current.version, observation: current.observation, requestKey: key });
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'osb-management-')); await mkdir(join(root, 'openspec/changes/feature'), { recursive: true });
  await writeFile(join(root, 'openspec/changes/feature/tasks.md'), '- [ ] unverified\n');
  process.env.CONFIG_PATH = join(root, 'config.json'); process.env.DATA_DIR = join(root, 'data');
  await writeFile(process.env.CONFIG_PATH, JSON.stringify({ port: 13002, sources: [{ name: 'demo', path: './openspec' }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl(); store = app.get(WorkStore);
  store.save({ id: 'w', sourceId: 'demo', changeName: 'feature', projectPath: root, requestKey: 'fixture-work', ideaIds: [], phase: 'planning', state: 'running', threadId: 'thread', turnId: 'run-1', reviewedVersion: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' });
  desktopHealth(store).register('fixture', () => 'active'); original = JSON.stringify(store.get('w'));
});
afterAll(async () => { await app?.close(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; });
it('exposes observed execution separately and refuses archive before administrative completion', async () => {
  const current = (await request()).data;
  expect(current).toMatchObject({ state: 'automatic', scope: 'work', runId: 'run-1', observed: { state: 'running', phase: 'planning', runtime: 'active' } });
  expect((await request(undefined, submission(current, 'archived', 'archive-too-soon'))).status).toBe(409);
});
it('records a manual completion receipt without changing execution, plan, ownership or completion proof', async () => {
  const current = (await request()).data, body = submission(current, 'completed', 'complete-fixture');
  const saved = await request(undefined, body); expect(saved.status).toBe(200);
  expect(saved.data.receipt).toMatchObject({ before: 'automatic', after: 'completed', scope: 'work', runId: 'run-1', actor: 'local-user' });
  expect(saved.data.observed.runtime).toBe('active'); expect(JSON.stringify(store.get('w'))).toBe(original);
  expect(app.get(DesktopLifecycle).status().idle).toBe(false);
  expect(store.events('w').filter(e => e.type === 'completed')).toHaveLength(0);
  const replay = await request(undefined, body); expect(replay.data.replayed).toBe(true); expect(replay.data.history).toHaveLength(1);
  expect((await request(undefined, { ...body, reason: 'different reason' })).status).toBe(409);
  expect((await request(undefined, { ...body, requestKey: 'stale-version' })).status).toBe(409);
});
it('archives only the administrative display and reflects that on the board with the original status retained', async () => {
  const current = (await request()).data, saved = await request(undefined, submission(current, 'archived', 'archive-fixture'));
  expect(saved.status).toBe(200); expect(saved.data.history).toHaveLength(2);
  const changes = (await request('changes')).data.changes;
  expect(changes[0]).toMatchObject({ status: 'archived', managementState: 'archived', observedStatus: 'todo' });
  expect(JSON.stringify(store.get('w'))).toBe(original);
  expect(app.get(DesktopLifecycle).status().idle).toBe(false);
});
it('keeps run management independent and rejects a changed execution observation', async () => {
  const run = (await request('work/w/management?scope=run')).data;
  expect(run.state).toBe('automatic');
  expect((await request(undefined, submission(run, 'completed', 'run-complete'))).status).toBe(200);
  expect((await request()).data.state).toBe('archived');
  const stale = (await request()).data; store.save({ ...store.get('w')!, turnId: 'run-2' });
  expect((await request(undefined, submission(stale, 'active', 'changed-run'))).status).toBe(409);
  expect((await request('work/w/management?scope=run')).data.state).toBe('automatic');
});
it('validates missing work, invalid states and reason, without clearing guards', async () => {
  expect((await request('work/missing/management')).status).toBe(404);
  const current = (await request()).data;
  expect((await request(undefined, { ...submission(current, 'idle', 'invalid-state') })).status).toBe(400);
  expect((await request(undefined, { ...submission(current, 'active', 'empty-reason'), reason: '' })).status).toBe(400);
  expect(store.get('w')?.phase).toBe('planning'); expect(desktopHealth(store).runtime(store.get('w')!)).toBe('active');
});
