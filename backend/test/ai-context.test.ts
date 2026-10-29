import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore, type Work } from '../src/work/store';
import { aiExecutionContext } from '../src/work/ai-context';
import { FileResults } from '../src/work/file-results';
let dir: string, source: string, change: string, store: WorkStore, work: Work;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-context-')); source = join(dir, 'source'); change = join(source, 'openspec/changes/feature'); mkdirSync(change, { recursive: true }); writeFileSync(join(change, 'proposal.md'), '# plan');
  process.env.DATA_DIR = join(dir, 'data'); store = new WorkStore();
  work = { id: 'work-a', sourceId: 'source', projectPath: source, changeName: 'feature', requestKey: 'a', ideaIds: [], phase: 'planning', state: 'idle', threadId: 'same-thread', reviewedVersion: null, createdAt: '', updatedAt: '' }; store.save(work);
});
afterEach(() => { store.onApplicationShutdown(); delete process.env.DATA_DIR; delete process.env.WORKSPACE_ROOT; });
it('계획은 해당 변경만 쓰고 복사 후 계획/구현 모두 같은 고정 공간을 사용한다', () => {
  expect(aiExecutionContext(store, work)).toMatchObject({ cwd: change, writableRoots: [change], projectRoot: source, planning: true });
  new FileResults(store).prepare(work); const path = work.executionPath!;
  process.env.WORKSPACE_ROOT = join(dir, 'new-root');
  expect(aiExecutionContext(store, work)).toMatchObject({ cwd: join(path, 'openspec/changes/feature'), writableRoots: [join(path, 'openspec/changes/feature')] });
  expect(aiExecutionContext(store, work, 'implementation')).toMatchObject({ cwd: path, writableRoots: [path], planning: false }); expect(work.threadId).toBe('same-thread');
});
it('저장된 변경 이름이 제품 폴더를 가리키거나 문서가 외부 inode를 공유하면 계획을 차단한다', () => {
  mkdirSync(join(source, 'product')); writeFileSync(join(source, 'product/code.txt'), 'preserve');
  expect(() => aiExecutionContext(store, { ...work, changeName: '../../product' })).toThrow();
  linkSync(join(source, 'product/code.txt'), join(change, 'shared.md'));
  expect(() => aiExecutionContext(store, work)).toThrow(/링크|소유|문서/);
});
it('준비 기록의 실행 경로가 유실되면 계획도 원본에서 대신 실행하지 않는다', () => {
  new FileResults(store).prepare(work); delete work.executionPath;
  expect(() => aiExecutionContext(store, work)).toThrow(/복구/);
  expect(() => aiExecutionContext(store, work, 'implementation')).toThrow(/복구/);
});
