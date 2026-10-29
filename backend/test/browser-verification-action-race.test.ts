import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../src/work/store';
import { collectFiles } from '../src/work/file-results';
import { WorkService } from '../src/work/work.service';

let dir: string, root: string, store: WorkStore, service: WorkService, release: () => void;
let apply: ReturnType<typeof vi.fn>, freeze: ReturnType<typeof vi.fn>, assertPassed: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verification-action-race-')); root = join(dir, 'source');
  process.env.DATA_DIR = join(dir, 'data'); store = new WorkStore();
  // Source collection needs a real directory and raw tasks bytes; no fake revision hashes.
  require('node:fs').mkdirSync(root); writeFileSync(join(root, 'tasks.md'), '- [x] done'); writeFileSync(join(root, 'code.txt'), 'source');
  store.save({ id: 'a', sourceId: 's', projectPath: root, executionPath: root, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'verification', state: 'idle', threadId: 'thread', turnId: 'turn', reviewedVersion: 'reviewed', createdAt: '', updatedAt: '', browserScenario: { name: 'test' } });
  apply = vi.fn(() => ({ source: 'test' })); freeze = vi.fn(); assertPassed = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  service = new WorkService(store, { updates: { next() {} } } as any, {} as any, {} as any, { snapshot: () => collectFiles(root), commands: () => [{ id: 'test' }], results: () => [{ commandId: 'test', scope: 'full', status: 'passed', fresh: true }], apply, freeze } as any, {} as any, {} as any, { assertPassed } as any);
  vi.spyOn(service, 'get').mockImplementation(id => store.get(id)!);
  vi.spyOn(service, 'planVersion').mockReturnValue('reviewed');
  vi.spyOn(service, 'document').mockImplementation((_id, path) => ({ content: readFileSync(join(root, path), 'utf8'), path } as any));
  vi.spyOn(service, 'documents').mockReturnValue(['tasks.md']);
});
afterEach(() => { store.onApplicationShutdown(); delete process.env.DATA_DIR; rmSync(dir, { recursive: true, force: true }); });
it.each(['apply-changes', 'complete'])('%s 확인 중 업무 상태 변경은 반영·완료를 막는다', async action => {
  const pending = service.action('a', { action, confirmed: true }); const outcome = pending.then(() => null, error => error);
  expect(assertPassed).toHaveBeenCalled(); const work = store.get('a')!; work.state = 'running'; store.save(work); release();
  expect(await outcome).toBeInstanceOf(Error); expect(apply).not.toHaveBeenCalled(); expect(freeze).not.toHaveBeenCalled();
});
it.each(['apply-changes', 'complete'])('%s 확인 중 체크박스만 되돌려도 원시 소스 변경을 검출한다', async action => {
  const pending = service.action('a', { action, confirmed: true }); const outcome = pending.then(() => null, error => error);
  expect(assertPassed).toHaveBeenCalled(); writeFileSync(join(root, 'tasks.md'), '- [ ] undone'); release();
  expect(await outcome).toBeInstanceOf(Error); expect(apply).not.toHaveBeenCalled(); expect(freeze).not.toHaveBeenCalled();
});
it.each(['apply-changes', 'complete'])('%s 확인 중 새로운 질문은 반영·완료를 막는다', async action => {
  const pending = service.action('a', { action, confirmed: true }); const outcome = pending.then(() => null, error => error);
  expect(assertPassed).toHaveBeenCalled(); store.record('question', 'a', 'question', { status: 'pending' }); release();
  expect(await outcome).toBeInstanceOf(Error); expect(apply).not.toHaveBeenCalled(); expect(freeze).not.toHaveBeenCalled();
});
