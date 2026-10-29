import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectFiles } from '../src/work/file-results';
it('Git용 엄격 소스 집계는 junction을 누락된 정상 소스로 취급하지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'strict-source-')), source = join(root, 'source'), external = join(root, 'external'); mkdirSync(source); mkdirSync(external); writeFileSync(join(external, 'private.txt'), 'fixture-secret'); symlinkSync(external, join(source, 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => collectFiles(source, () => false, true)).toThrow(/링크|소유/);
});
it('Git용 엄격 소스 집계는 외부 inode를 공유하는 파일 본문을 읽지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'strict-source-')), source = join(root, 'source'); mkdirSync(source); const original = join(root, 'original.txt'); writeFileSync(original, 'fixture-secret'); linkSync(original, join(source, 'shared.txt'));
  expect(() => collectFiles(source, () => false, true)).toThrow(/링크|소유/);
});
