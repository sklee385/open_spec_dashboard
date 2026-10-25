import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, within } from '../src/files';
it('프로젝트 밖으로 이어지는 디렉터리 링크를 거부한다', () => {
  const base = mkdtempSync(join(tmpdir(), 'openspec-path-')), outside = mkdtempSync(join(tmpdir(), 'openspec-outside-'));
  symlinkSync(outside, join(base, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => within(base, 'linked/new.md')).toThrow('outside project');
  expect(() => within(base, '../elsewhere.md')).toThrow('outside project');
});
it('원자 교체 실패 시 원본을 보존하고 임시 파일을 정리한다', () => {
  const base = mkdtempSync(join(tmpdir(), 'openspec-atomic-')), target = join(base, 'document.md');
  mkdirSync(target); writeFileSync(join(target, 'original'), '보존');
  expect(() => atomicWrite(target, '수정')).toThrow();
  expect(readFileSync(join(target, 'original'), 'utf8')).toBe('보존');
  expect(readdirSync(base)).toEqual(['document.md']);
});
