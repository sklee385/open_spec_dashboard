import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectWorkspaceDocuments, copyWorkspaceDocuments } from '../src/work/workspace-documents';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'docs-')), source = join(dir, 'source'), target = join(dir, 'target'), change = join(source, 'openspec', 'changes', 'feature');
  mkdirSync(join(change, 'specs', 'feature'), { recursive: true }); mkdirSync(target);
  for (const name of ['proposal.md', 'design.md', 'tasks.md', '.openspec.yaml', 'specs/feature/spec.md']) writeFileSync(join(change, name), `${name}\n`);
  return { dir, source, target, change };
}
it('해당 검토 문서와 source-ideas만 수집하고 원문/계획 revision을 따로 기록한다', () => {
  const f = fixture(); mkdirSync(join(f.change, 'source-ideas')); writeFileSync(join(f.change, 'source-ideas', 'idea.md'), '# idea');
  writeFileSync(join(f.change, 'verification.md'), 'excluded'); writeFileSync(join(f.source, '.env'), 'SECRET=excluded');
  const manifest = collectWorkspaceDocuments(f.source, 'feature'); expect(manifest.files).toHaveLength(6);
  expect(manifest.files.every(file => file.path.startsWith('openspec/changes/feature/'))).toBe(true);
  expect(JSON.stringify(manifest)).not.toContain('SECRET='); expect(JSON.stringify(manifest)).not.toContain('verification.md');
  writeFileSync(join(f.change, 'tasks.md'), '- [ ] implement\n'); const before = collectWorkspaceDocuments(f.source, 'feature');
  writeFileSync(join(f.change, 'tasks.md'), '- [x] implement\n'); const progress = collectWorkspaceDocuments(f.source, 'feature');
  expect(progress.revision).not.toBe(before.revision); expect(progress.planRevision).toBe(before.planRevision);
  writeFileSync(join(f.change, 'tasks.md'), '- [x] changed requirement\n'); expect(collectWorkspaceDocuments(f.source, 'feature').planRevision).not.toBe(progress.planRevision);
});
it('검토 문서만 독립 복사하고 선택 기준의 제품 파일·다른 업무·비밀값은 보존/제외한다', () => {
  const f = fixture(), prefix = join(f.target, 'openspec', 'changes', 'feature'); mkdirSync(join(prefix, 'specs', 'old'), { recursive: true });
  writeFileSync(join(prefix, 'specs', 'old', 'spec.md'), 'stale'); writeFileSync(join(f.target, 'code.txt'), 'committed baseline'); writeFileSync(join(f.source, 'code.txt'), 'dirty source'); writeFileSync(join(f.source, '.env'), 'SECRET=excluded');
  mkdirSync(join(f.source, 'openspec', 'changes', 'other'), { recursive: true }); writeFileSync(join(f.source, 'openspec', 'changes', 'other', 'proposal.md'), 'other work');
  const manifest = collectWorkspaceDocuments(f.source, 'feature'); copyWorkspaceDocuments(f.source, f.target, 'feature', manifest.revision);
  expect(readFileSync(join(f.target, 'code.txt'), 'utf8')).toBe('committed baseline');
  expect(existsSync(join(f.target, '.env'))).toBe(false); expect(existsSync(join(f.target, 'openspec', 'changes', 'other'))).toBe(false); expect(existsSync(join(prefix, 'specs', 'old', 'spec.md'))).toBe(false);
  expect(collectWorkspaceDocuments(f.target, 'feature').revision).toBe(manifest.revision);
  writeFileSync(join(prefix, 'proposal.md'), 'workspace edit'); expect(readFileSync(join(f.change, 'proposal.md'), 'utf8')).toBe('proposal.md\n');
});
it('미검토 revision·경계 이탈·링크와 hardlink 문서는 복사 전에 차단한다', () => {
  const f = fixture(), manifest = collectWorkspaceDocuments(f.source, 'feature');
  writeFileSync(join(f.change, 'proposal.md'), 'changed');
  expect(() => copyWorkspaceDocuments(f.source, f.target, 'feature', manifest.revision)).toThrow(/변경|검토/);
  expect(existsSync(join(f.target, 'openspec'))).toBe(false);
  expect(() => collectWorkspaceDocuments(f.source, '../feature')).toThrow();
  linkSync(join(f.change, 'proposal.md'), join(f.change, 'source-copy.md'));
  expect(() => collectWorkspaceDocuments(f.source, 'feature')).toThrow(/링크|소유/);
  const other = fixture(); mkdirSync(join(other.dir, 'external')); symlinkSync(join(other.dir, 'external'), join(other.target, 'openspec'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => copyWorkspaceDocuments(other.source, other.target, 'feature', collectWorkspaceDocuments(other.source, 'feature').revision)).toThrow(/링크|reparse/);
  expect(existsSync(join(other.dir, 'external', 'changes'))).toBe(false);
});
