import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore, type Work } from '../src/work/store';
import { WorkspacePreparation } from '../src/work/workspace-preparation';
import { WorkspaceService } from '../src/work/workspace.service';
import { FileResults } from '../src/work/file-results';
let store: WorkStore, dir: string, work: Work;
const policy = { maxActiveWorks: 3, minimumFreeBytes: 100, retentionDays: 14 };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'preparation-')); process.env.DATA_DIR = join(dir, 'data'); process.env.WORKSPACE_ROOT = join(dir, 'spaces');
  const original = join(dir, 'original'); mkdirSync(original); writeFileSync(join(original, 'source.txt'), 'original');
  store = new WorkStore(); work = { id: 'a', sourceId: 's', projectPath: original, changeName: 'feature', requestKey: 'a', ideaIds: [], phase: 'reviewed', state: 'idle', threadId: 'same-thread', reviewedVersion: 'plan', createdAt: '', updatedAt: '' }; store.save(work);
});
afterEach(() => { store.onApplicationShutdown(); delete process.env.DATA_DIR; delete process.env.WORKSPACE_ROOT; });
it('준비 전 미확인·부족 용량이면 생성·설치·빌드를 실행하지 않는다', () => {
  for (const free of [null, 99]) {
    const guard = new WorkspacePreparation(store, { policy: () => policy, freeBytes: () => free }); let called = false;
    expect(() => guard.run(work, join(dir, 'new'), 'install', () => { called = true; })).toThrow(/용량/);
    expect(called).toBe(false); expect(existsSync(join(dir, 'new'))).toBe(false);
    expect(store.records(work.id, 'workspace-preparation').at(-1)).toMatchObject({ status: 'failed', stage: 'install' });
  }
});
it('준비 후 용량 소진이면 부분 산출물을 보존하고 오류 기록과 경로 차단을 남긴다', () => {
  let free = 1000; const guard = new WorkspacePreparation(store, { policy: () => policy, freeBytes: () => free });
  const output = join(dir, 'partial-build');
  work.workspace = { status: 'preparing', executionPath: join(dir, 'space') } as any;
  expect(() => guard.run(work, join(dir, 'space'), 'build', () => { writeFileSync(output, 'preserve'); free = 10; })).toThrow(/용량/);
  expect(existsSync(output)).toBe(true); expect(store.get(work.id)).toMatchObject({ state: 'failed', threadId: 'same-thread', workspace: { status: 'failed' } });
  expect(() => new WorkspaceService(store).path(work)).toThrow(/복구/);
});
it('실제 복사 전후 검사에 연결하고 복사 뒤 부족하면 AI에 사용할 baseline을 만들지 않는다', () => {
  let copied = false;
  const spaces = new WorkspaceService(store, { preparation: { policy: () => policy, freeBytes: path => { if (path.endsWith('project')) { if (copied) return 0; copied = true; } return 1000; } } });
  expect(() => new FileResults(store, spaces).prepare(work)).toThrow(/용량/);
  const failed = store.records(work.id, 'workspace-preparation').find(row => row.status === 'failed' && row.stage === 'copy');
  expect(failed).toMatchObject({ stage: 'copy' }); expect(existsSync(join(failed.executionPath, 'source.txt'))).toBe(true);
  expect(store.records(work.id, 'isolated-baseline')).toHaveLength(0); expect(work.executionPath).toBeUndefined();
  expect(() => spaces.path(work)).toThrow(/복구/);
  expect(() => new FileResults(store, spaces).prepare(work)).toThrow(/복구/);
});
it('비동기 설치가 끝난 뒤에도 잔여를 다시 확인하고 실패 산출물을 보존한다', async () => {
  let free = 1000; const output = join(dir, 'installed');
  const guard = new WorkspacePreparation(store, { policy: () => policy, freeBytes: () => free });
  await expect(guard.run(work, join(dir, 'space'), 'install', async () => { await Promise.resolve(); writeFileSync(output, 'partial'); free = 0; })).rejects.toThrow(/용량/);
  expect(existsSync(output)).toBe(true); expect(store.records(work.id, 'workspace-preparation').at(-1)).toMatchObject({ stage: 'install', status: 'failed' });
});
it('복사 뒤 무결성 검사가 실패해도 실패 기록을 남겨 새 UUID 복사 재시도를 막는다', () => {
  let copied = false;
  const spaces = new WorkspaceService(store, { preparation: { policy: () => policy, freeBytes: path => {
    if (path.endsWith('project')) { if (copied) writeFileSync(join(work.projectPath, 'source.txt'), 'changed'); copied = true; }
    return 1000;
  } } });
  expect(() => new FileResults(store, spaces).prepare(work)).toThrow(/원본/);
  expect(store.records(work.id, 'workspace-preparation').some(record => record.status === 'failed')).toBe(true);
  expect(() => new FileResults(store, spaces).prepare(work)).toThrow(/복구/);
});
