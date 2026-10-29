import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectCapacity } from '../src/work/workspace-capacity';
const file = (path: string, size: number) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, Buffer.alloc(size)); };
it('업무·후보·공유·중단 및 미등록 공간을 포함하고 의존성과 빌드를 누락하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-')), managed = join(dir, 'managed');
  file(join(managed, 'projects', 'p', 'works', 'a', 'project', 'node_modules', 'dep'), 7);
  file(join(managed, 'projects', 'p', 'works', 'a', 'project', 'dist', 'build'), 11);
  file(join(managed, 'projects', 'p', 'works', 'interrupted', 'project', 'partial'), 13);
  file(join(managed, 'projects', 'p', 'integrations', 'c', 'evidence', 'screen'), 17);
  file(join(managed, 'shared', 'browser'), 19); file(join(managed, 'orphan', 'partial'), 23);
  const result = inspectCapacity([{ rootId: 'r', path: dir, managedPath: managed }]);
  expect(result.status).toBe('complete'); expect(result.bytes).toBe(90);
  expect(result.roots[0].works).toEqual(expect.arrayContaining([expect.objectContaining({ workspaceId: 'a', bytes: 18 }), expect.objectContaining({ workspaceId: 'interrupted', bytes: 13 })]));
  expect(result.roots[0].candidates[0]).toMatchObject({ workspaceId: 'c', bytes: 17 });
  expect(result.shared.bytes).toBe(19); expect(result.roots[0].otherBytes).toBe(23);
  expect(result.roots[0].freeBytes).toBeGreaterThan(0); expect(Date.parse(result.measuredAt)).toBeGreaterThan(0);
});
it('링크를 따라가지 않고 hardlink와 중복 공유 위치를 전체에 두 번 합산하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-links-')), managed = join(dir, 'managed'), shared = join(dir, 'git-common');
  file(join(managed, 'shared', 'browser'), 19); linkSync(join(managed, 'shared', 'browser'), join(managed, 'shared', 'browser-hardlink'));
  file(join(shared, 'objects', 'pack'), 23);
  symlinkSync(shared, join(managed, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = inspectCapacity([{ rootId: 'r', path: dir, managedPath: managed }], { sharedPaths: [shared, shared] });
  expect(result.bytes).toBe(42); expect(result.shared.bytes).toBe(42);
  expect(result.roots[0].bytes).toBe(19); expect(result.roots[0].skippedLinks).toBe(1);
});
it('유실·잔여 공간 확인 실패·집계 예산 소진은 0 사용량 성공으로 표시하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capacity-missing-'));
  const missing = inspectCapacity([{ rootId: 'lost', path: join(dir, 'missing'), managedPath: join(dir, 'missing', 'managed') }]);
  expect(missing.status).toBe('partial'); expect(missing.bytes).toBeNull(); expect(missing.roots[0].freeBytes).toBeNull();
  file(join(dir, 'managed', 'a'), 5); file(join(dir, 'managed', 'b'), 7);
  const limited = inspectCapacity([{ rootId: 'r', path: dir, managedPath: join(dir, 'managed') }], { maxEntries: 1, freeBytes: () => { throw new Error('unavailable'); } });
  expect(limited.status).toBe('partial'); expect(limited.roots[0].freeBytes).toBeNull(); expect(limited.roots[0].errors.length).toBeGreaterThan(0);
});
