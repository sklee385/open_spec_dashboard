import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRollout } from '../src/codex/rollout';

it('이름이 아닌 원본 메타데이터 ID와 프로젝트 경로로 대화 파일을 검증한다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rollout-'));
  const folder = join(home, 'sessions', '2026', '10', '25'); await mkdir(folder, { recursive: true });
  const file = join(folder, 'rollout-2026-10-25-thread-1.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'other', cwd: process.cwd() } }) + '\n');
  expect(await findRollout('thread-1', process.cwd(), home)).toBeUndefined();
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1', cwd: process.cwd() } }) + '\n');
  expect(await findRollout('thread-1', process.cwd(), home)).toBe(file);
  expect(await findRollout('thread-1', tmpdir(), home)).toBeUndefined();
  expect(await findRollout('../thread-1', process.cwd(), home)).toBeUndefined();
});
