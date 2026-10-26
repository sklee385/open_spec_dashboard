import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkStore } from '../src/work/store';
import { FileResults } from '../src/work/file-results';
import { DesktopLifecycle } from '../src/desktop/lifecycle';
import { BrowserService } from '../src/browser/browser.service';
import { AiToolService } from '../src/ai-tools/ai-tool.service';

let app: INestApplication, base: string, store: WorkStore;
const scenario = { name: '첫 화면', server: { command: 'node', args: ['server.cjs'], url: 'http://127.0.0.1:14321' }, steps: [{ op: 'goto', path: '/' }, { op: 'expectVisible', target: { role: 'heading', name: '검증' } }] };
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-api-')); mkdirSync(join(root, 'openspec'));
  process.env.DATA_DIR = join(root, '.data'); process.env.CONFIG_PATH = join(root, 'config.json');
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'test', path: './openspec' }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/work`;
  store = app.get(WorkStore);
  const work = store.save({ id: 'api', sourceId: 'test', projectPath: root, changeName: 'api', requestKey: 'api', ideaIds: [], phase: 'implementation', state: 'idle', threadId: 'existing', reviewedVersion: null, createdAt: '', updatedAt: '' });
  new FileResults(store).prepare(work);
});
afterAll(async () => { await app?.close(); delete process.env.DATA_DIR; delete process.env.CONFIG_PATH; });
it('업무별 시나리오 API가 유효성·업무 경계를 검사한다', async () => {
  expect((await fetch(`${base}/missing/browser`)).status).toBe(404);
  const saved = await fetch(`${base}/api/browser/scenario`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scenario) });
  expect(saved.status).toBe(200); expect(await saved.json()).toMatchObject({ scenario: { name: '첫 화면' }, results: [] });
  const invalid = await fetch(`${base}/api/browser/scenario`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scenario, server: { ...scenario.server, url: 'http://example.com' } }) });
  expect(invalid.status).toBe(400); expect(store.get('api')?.threadId).toBe('existing');
});
it('질문·승인 대기 중 실행을 거부하고 브라우저 검증이 종료·업데이트를 막는다', async () => {
  store.record('pending', 'api', 'question', { status: 'pending', kind: 'approval' });
  expect((await fetch(`${base}/api/browser/run`, { method: 'POST' })).status).toBe(409);
  store.record('pending', 'api', 'question', { status: 'answered', kind: 'approval' });
  store.record('running', 'api', 'browser-verification', { status: 'running' });
  expect(app.get(DesktopLifecycle).status().idle).toBe(false);
  expect(() => app.get(DesktopLifecycle).prepare()).toThrow();
  store.record('running', 'api', 'browser-verification', { status: 'interrupted' });
  expect(app.get(DesktopLifecycle).status().idle).toBe(true);
});
it('AI 소유 브라우저 실행 중 일반 중단은 AI 턴까지 중단한다', async () => {
  const browser = app.get(BrowserService), ai = app.get(AiToolService);
  const status = vi.spyOn(browser, 'status').mockReturnValue({ scenario, running: true, busy: true, results: [{ id: 'tool', owner: 'tool', fresh: true }] });
  const cancel = vi.spyOn(browser, 'cancel').mockResolvedValue({ requested: true });
  const interrupt = vi.spyOn(ai, 'interrupt').mockResolvedValue({ requested: true });
  try {
    expect((await fetch(`${base}/api/interrupt`, { method: 'POST' })).status).toBe(200);
    expect(cancel).toHaveBeenCalledWith('api'); expect(interrupt).toHaveBeenCalledWith('api');
  } finally { status.mockRestore(); cancel.mockRestore(); interrupt.mockRestore(); }
});
