import { expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ExecutionService } from '../src/work/execution.service';
import type { Work, WorkStore } from '../src/work/store';
import type { LegacyService } from '../src/legacy/legacy.service';
it.each([false, true])('Git 사용 여부(%s)에 관계없이 동일하게 변경을 보여준다', git => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-execution-')); writeFileSync(join(root, 'code.txt'), '이전');
  if (git) { execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' }); execFileSync('git', ['add', 'code.txt'], { cwd: root, stdio: 'ignore' }); execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' }); }
  let baseline: unknown;
  const store = { list: () => [], records: (_id: string, kind: string) => kind === 'baseline' && baseline ? [baseline] : [], record: vi.fn((_id, _work, _kind, data) => { baseline = data; }) } as unknown as WorkStore;
  const execution = new ExecutionService(store, {} as LegacyService), work = { id: 'work', projectPath: root } as Work;
  execution.baseline(work); writeFileSync(join(root, 'code.txt'), '다음');
  expect(execution.changes(work)).toEqual([{ path: 'code.txt', before: '이전', after: '다음', status: 'modified' }]);
  if (git) expect(store.record.mock.calls[0][3].gitHead).toMatch(/^[a-f0-9]{40,64}$/);
});
