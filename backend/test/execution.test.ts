import { expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ExecutionService } from '../src/work/execution.service';
import { type Work, WorkStore } from '../src/work/store';
import type { LegacyService } from '../src/legacy/legacy.service';
it.each([false, true])('Git 사용 여부(%s)에 관계없이 동일하게 변경을 보여준다', git => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-execution-')); writeFileSync(join(root, 'code.txt'), '이전');
  if (git) { execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' }); execFileSync('git', ['add', 'code.txt'], { cwd: root, stdio: 'ignore' }); execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' }); }
  const previousData = process.env.DATA_DIR; process.env.DATA_DIR = join(root, 'data');
  const store = new WorkStore();
  const execution = new ExecutionService(store, {} as LegacyService), work = { id: 'work', projectPath: root, sourceId: 'test', changeName: 'test', requestKey: 'test' } as Work;
  store.save(work);
  try {
    execution.prepare(work); writeFileSync(join(execution.executionPath(work), 'code.txt'), '다음');
    expect(execution.changes(work)).toMatchObject([{ path: 'code.txt', before: '이전', after: '다음', status: 'modified' }]);
  } finally { store.onApplicationShutdown(); if (previousData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousData; }
});
