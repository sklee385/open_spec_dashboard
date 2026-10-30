import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { WorkStore, type Work } from '../src/work/store';
import { FileResults } from '../src/work/file-results';
import { CompletedResults } from '../src/work/completed-results';
let store: WorkStore, work: Work, root: string;
const workspaceRoot = process.env.WORKSPACE_ROOT; const saved = process.env.DATA_DIR, hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cret-')); process.env.WORKSPACE_ROOT = join(root, 'workspaces'); process.env.DATA_DIR = join(root, 'data'); store = new WorkStore();
  const source = join(root, 'source'); mkdirSync(source); mkdirSync(join(source, 'openspec/changes/a'), { recursive: true }); writeFileSync(join(source, 'openspec/changes/a/tasks.md'), '- [x] done'); writeFileSync(join(source, 'code.txt'), 'before');
  work = store.save({ id: 'a', sourceId: 'fixture', projectPath: source, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'verification', state: 'idle', threadId: 'same-thread', reviewedVersion: null, createdAt: '', updatedAt: '' });
});
afterEach(() => { vi.restoreAllMocks(); store.onApplicationShutdown(); if (saved === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = saved; if (workspaceRoot === undefined) delete process.env.WORKSPACE_ROOT; else process.env.WORKSPACE_ROOT = workspaceRoot; });
const file = (path: string, before: string | null, after: string | null) => ({ path, status: before === null ? 'added' : after === null ? 'removed' : 'modified', before, after, beforeAvailability: before === null ? 'absent' : 'text', afterAvailability: after === null ? 'absent' : 'text', beforeHash: before === null ? null : hash(before), afterHash: after === null ? null : hash(after) });
const report = (files: ReturnType<typeof file>[]) => ({ source: 'completed', isolated: true, application: 'applied', revision: 'a'.repeat(64), endedAt: new Date().toISOString(), files });
it('실제 copy 완료 뒤 공간이 사라져도 본문·요약은 앱 DB에서 읽고 전체 records나 소스를 다시 읽지 않는다', () => {
  const files = new FileResults(store); files.prepare(work); writeFileSync(join(work.executionPath!, 'code.txt'), 'after'); files.apply(work); files.freeze(work);
  const old = work.executionPath!, moved = old + '.detached', rel = relative(root, moved); if (isAbsolute(rel) || rel.startsWith('..'+sep) || rel === '..') throw Error('fixture path'); renameSync(old, moved);
  vi.spyOn(store, 'records').mockImplementation(() => { throw Error('whole records read'); }); vi.spyOn(files, 'snapshot').mockImplementation(() => { throw Error('source read'); });
  const retained = files.report(work); expect(retained).toMatchObject({ source: 'completed', files: [], retained: { workId: 'a', fileCount: 1 } });
  const reader = new CompletedResults(store), page = reader.files('a', retained.retained.captureId, 0, 25); expect(page.files).toHaveLength(1); expect(reader.file('a', retained.retained.captureId, page.files[0].ordinal)).toMatchObject({ path: 'code.txt', before: 'before', after: 'after' });
});
it('파일 목록은 본문을 내보내지 않고 명시한 cursor·capture·업무에만 묶이며 옛 캡처를 보존한다', () => {
  const reader = new CompletedResults(store), old = reader.capture(work, report([file('one.txt', null, 'large private fixture body'), file('two.txt', null, 'two')]), [], { appliedCommit: 'b'.repeat(40) });
  const captureId = old.retained.captureId, first = reader.files(work.id, captureId, 0, 1); expect(first.nextCursor).toBe(1); expect(JSON.stringify(first)).not.toContain('large private fixture body');
  expect(reader.files(work.id, captureId, first.nextCursor!, 1)).toMatchObject({ files: [{ ordinal: 1, path: 'two.txt' }], nextCursor: null });
  reader.capture(work, report([file('new.txt', null, 'new')])); expect(reader.file(work.id, captureId, 0).after).toBe('large private fixture body');
  store.save({ ...work, id: 'b', requestKey: 'b', changeName: 'b' }); expect(() => reader.file('b', captureId, 0)).toThrow(); expect(() => reader.files(work.id, captureId, 0, 1000000)).toThrow();
});
it('14일 경과는 available 자료의 정리 제안일 뿐이며 확인한 만료 기록 뒤에만 링크와 이미지가 사라진다', () => {
  const environmentId = randomUUID(), id = randomUUID(), directory = join(process.env.DATA_DIR!, 'verification-environments', environmentId, 'evidence'), bytes = Buffer.from([255, 216, 255, 217]); mkdirSync(directory, { recursive: true }); const path = join(directory, id+'.jpg'); writeFileSync(path, bytes);
  store.record(id, work.id, 'browser-verification', { status: 'passed', targetKind: 'work', environmentId, evidencePath: path, createdAt: new Date(Date.now()-20*86400000).toISOString() });
  const reader = new CompletedResults(store), capture = reader.capture(work, report([]), [{ id, kind: 'browser-verification' }]);
  const captureId = capture.retained.captureId, evidence = reader.verifications(work.id, captureId, 0, 25).results[0].evidence; expect(evidence).toMatchObject({ id, state: 'available', eligibleForCleanup: true }); expect(evidence.url).toMatch(/^\/api\/work\/a\/completion\/evidence\//); expect(reader.image(work.id, captureId, id)).toEqual(bytes); expect(reader.verifications(work.id, captureId, 0, 25, 30).results[0].evidence).toMatchObject({ state: 'available', eligibleForCleanup: false });
  reader.expireEvidence(work.id, captureId, id, { confirmed: true, expectedHash: hash(bytes) }); expect(reader.verifications(work.id, captureId, 0, 25).results[0].evidence).toMatchObject({ state: 'expired' }); expect(reader.verifications(work.id, captureId, 0, 25).results[0].evidence?.url).toBeUndefined(); expect(() => reader.image(work.id, captureId, id)).toThrow(); expect(readFileSync(path)).toEqual(bytes);
});
it('잘못된 경로·본문 한도 초과를 조용히 잘라 완료하지 않고 캡처 transaction을 되돌린다', () => {
  const reader = new CompletedResults(store); expect(() => reader.capture(work, report([file('../outside', null, 'x')]))).toThrow();
  expect(() => reader.capture(work, report([file('huge.txt', null, 'x'.repeat(200001))]))).toThrow(); expect(reader.header(work.id)).toBeNull(); expect(store.get(work.id)?.phase).toBe('verification');
});