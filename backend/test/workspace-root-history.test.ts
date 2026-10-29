import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/app';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorkStore, type Work } from '../src/work/store';
import { WorkspaceService } from '../src/work/workspace.service';
import { CodexService } from '../src/codex/codex.service';
import { CodexClient } from '../src/codex/client';
let app: any, base: string, dir: string, settings: WorkspaceSettingsService, store: WorkStore;
const request = async (method: string, suffix = '', body?: unknown) => {
  const response = await fetch(`${base}/api/workspace-settings${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
};
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'root-history-')); process.env.CONFIG_PATH = join(dir, 'config.json'); process.env.DATA_DIR = join(dir, 'data'); delete process.env.WORKSPACE_ROOT;
  mkdirSync(join(dir, 'original', 'openspec'), { recursive: true });
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: './original/openspec' }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl(); settings = app.get(WorkspaceSettingsService); store = app.get(WorkStore);
  vi.spyOn(settings, 'protectedPaths').mockReturnValue([join(dir, 'data'), join(dir, 'original')]);
});
afterAll(async () => { await app?.close(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; delete process.env.WORKSPACE_ROOT; });
const select = async (name: string) => {
  const current = settings.read(), checked = (await request('POST', '/check', { version: current.version, path: join(dir, name) })).data;
  const saved = await request('PUT', '', { version: current.version, token: checked.token, confirmed: true }); expect(saved.status).toBe(200); return saved.data;
};
it('질문 대기 A의 예약 경로와 대화를 보존하고 새 루트에 B를 예약하며 참조 등록 해제를 거부한다', async () => {
  const first = await select('root-a'), original = join(dir, 'original');
  const a: Work = { id: 'a', sourceId: 'demo', projectPath: original, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'implementation', state: 'idle', threadId: 'thread-a', reviewedVersion: 'plan-a', createdAt: '', updatedAt: '' };
  store.save(a); const spaces = new WorkspaceService(store, { protectedPaths: () => [original] });
  const reserved = spaces.reserve(a, settings, 'copy');
  store.record('q-a', a.id, 'question', { status: 'pending', kind: 'input', text: 'keep me' });
  const second = await select('root-b');
  const b = { ...a, id: 'b', requestKey: 'b', changeName: 'b', threadId: 'thread-b', workspace: undefined, executionPath: undefined }; store.save(b);
  const next = spaces.reserve(b, settings, 'copy');
  expect(reserved.rootId).toBe(first.selectedRootId); expect(next.rootId).toBe(second.selectedRootId); expect(next.executionPath.startsWith(second.managedPath)).toBe(true);
  expect(store.get('a')).toMatchObject({ threadId: 'thread-a', executionPath: reserved.executionPath, workspace: reserved });
  expect(store.records('a', 'question')[0]).toMatchObject({ status: 'pending', text: 'keep me' });
  const history = await request('GET', '/roots'); expect(history.status).toBe(200); expect(history.data.roots).toHaveLength(2);
  expect(history.data.roots.find((r: any) => r.rootId === reserved.rootId).references).toEqual(expect.arrayContaining([expect.objectContaining({ workId: 'a' })]));
  expect((await request('DELETE', `/roots/${reserved.rootId}`, { version: second.version })).status).toBe(409);
  expect((await request('DELETE', `/roots/${next.rootId}`, { version: second.version })).status).toBe(409);
});
it('참조 없는 과거 루트만 해제하며 후보 참조·환경 고정·오래된 버전을 거부하고 파일을 보존한다', async () => {
  const unused = await select('unused'), unusedId = unused.selectedRootId;
  writeFileSync(join(unused.managedPath, 'retained.txt'), 'keep');
  const selected = await select('current');
  store.record('candidate-only', 'a', 'integration-candidate', { rootId: unusedId, status: 'ready' });
  expect((await request('DELETE', `/roots/${unusedId}`, { version: selected.version })).status).toBe(409);
  store.db.prepare('DELETE FROM records WHERE id=?').run('candidate-only');
  expect((await request('DELETE', `/roots/${unusedId}`, { version: selected.version - 1 })).status).toBe(409);
  process.env.WORKSPACE_ROOT = `${unused.path}/`;
  expect((await request('DELETE', `/roots/${unusedId}`, { version: selected.version })).status).toBe(409);
  delete process.env.WORKSPACE_ROOT;
  expect((await request('DELETE', `/roots/${unusedId}`, { version: selected.version })).status).toBe(200);
  expect(settings.read().roots.some(r => r.rootId === unusedId)).toBe(false);
  expect(readFileSync(join(unused.managedPath, 'retained.txt'), 'utf8')).toBe('keep'); expect(existsSync(unused.managedPath)).toBe(true);
});
it('용량 정책을 버전과 함께 저장하고 오래된 요청·잘못된 값을 거부한다', async () => {
  const initial = settings.read();
  const policy = { maxActiveWorks: 2, minimumFreeBytes: 123456, retentionDays: 30 };
  const saved = await request('PUT', '/policy', { version: initial.version, policy });
  expect(saved.status).toBe(200); expect(saved.data.policy).toEqual(policy);
  expect(settings.read().policy).toEqual(policy);
  expect((await request('PUT', '/policy', { version: initial.version, policy })).status).toBe(409);
  expect((await request('PUT', '/policy', { version: saved.data.version, policy: { ...policy, maxActiveWorks: 0 } })).status).toBe(400);
  expect(settings.read().version).toBe(saved.data.version);
});
it('한도 초과 구현 요청은 준비와 AI 실행 전에 대기 오류를 반환한다', async () => {
  const owner = store.get('a')!;
  const waiting = { ...owner, id: 'waiting', requestKey: 'waiting', changeName: 'waiting', workspace: undefined, executionPath: undefined }; store.save(waiting);
  const response = await fetch(`${base}/api/work/waiting/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'implement' }) });
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ errorCode: 'workspace-active-limit' });
  expect(store.get('waiting')).toMatchObject({ state: 'idle', threadId: owner.threadId });
  expect(store.records('waiting', 'workspace-preparation')).toHaveLength(0);
});
it('구현 대화 연결을 기다리는 동안에도 활성 슬롯을 먼저 예약한다', async () => {
  for (const owner of store.list()) store.save({ ...owner, phase: 'completed' });
  settings.update(settings.read().version, draft => { draft.policy.maxActiveWorks = 1; });
  const template = store.get('a')!;
  for (const id of ['connecting-a', 'connecting-b']) store.save({ ...template, id, requestKey: id, changeName: id, phase: 'reviewed', state: 'idle', workspace: undefined, executionPath: join(dir, id) });
  const codex = app.get(CodexService) as CodexService;
  const releases: ((error: Error) => void)[] = [];
  const paths = vi.spyOn(WorkspaceService.prototype, 'path').mockImplementation(owner => { const path = join(dir, owner.id); mkdirSync(join(path, 'openspec/changes', owner.changeName), { recursive: true }); return path; });
  const ready = vi.spyOn(CodexClient.prototype, 'ready').mockImplementation(() => new Promise((_resolve, reject) => { releases.push(reject); }));
  const reviewed = vi.spyOn(codex as any, 'requireReviewedPlan').mockReturnValue(undefined);
  const first = codex.send('connecting-a', 'start', 'implementation').catch(error => error);
  let secondError: Error | undefined;
  const second = codex.send('connecting-b', 'start', 'implementation').catch(error => { secondError = error; });
  try {
    await Promise.resolve();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(secondError?.message).toMatch(/대기/);
    expect(store.get('connecting-a')).toMatchObject({ phase: 'implementation', state: 'connecting' });
    expect(store.get('connecting-b')).toMatchObject({ phase: 'reviewed', state: 'idle' });
  } finally { releases.forEach(release => release(new Error('테스트 연결 대기 종료'))); await Promise.allSettled([first, second]); ready.mockRestore(); reviewed.mockRestore(); paths.mockRestore(); }
});
