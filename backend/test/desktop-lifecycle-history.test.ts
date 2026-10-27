import { afterEach, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../src/work/store';
import { DesktopLifecycle } from '../src/desktop/lifecycle';

let store: WorkStore | undefined;
const originalDataDir = process.env.DATA_DIR;
afterEach(() => {
  store?.onApplicationShutdown();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

it('전송 결과가 불명확한 과거 메시지와 만료 질문은 유휴 업무의 업데이트를 막지 않고 보존한다', () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'desktop-lifecycle-'));
  store = new WorkStore();
  store.save({ id: 'work', sourceId: 'test', projectPath: '.', changeName: 'test', requestKey: 'test', ideaIds: [], phase: 'implementation', state: 'idle', threadId: 'thread', reviewedVersion: null, createdAt: '', updatedAt: '' });
  store.record('message', 'work', 'queued-message', { status: 'uncertain', text: '보존할 메시지' });
  const lifecycle = new DesktopLifecycle(store);
  expect(lifecycle.prepare()).toMatchObject({ idle: true, locked: true });
  expect(store.records('work', 'queued-message')).toEqual([{ id: 'message', status: 'uncertain', text: '보존할 메시지' }]);
  for (const status of ['pending', 'queued', 'dispatching']) {
    store.record('message', 'work', 'queued-message', { status });
    expect(() => lifecycle.prepare()).toThrow();
  }
  store.record('message', 'work', 'queued-message', { status: 'uncertain' });
  store.record('question', 'work', 'question', { kind: 'input', status: 'expired' });
  expect(lifecycle.prepare()).toMatchObject({ idle: true });
  expect(store.records('work', 'question')[0].status).toBe('expired');
  for (const status of ['pending', 'sending', 'uncertain', 'recovering']) {
    store.record('question', 'work', 'question', { kind: 'input', status });
    expect(() => lifecycle.prepare()).toThrow();
  }
  store.record('question', 'work', 'question', { kind: 'input', status: 'expired' });
  store.save({ ...store.get('work')!, state: 'running' });
  expect(() => lifecycle.prepare()).toThrow();
});
