import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Work } from '../src/work/store';
import { bindReviewedPlan, fullReviewedPlan } from '../src/work/reviewed-plan';
it('추가 계획 문서 변경은 기존 검토 hash를 무효화하고 명시적 재검토만 새 기준을 인정한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-plan-')), docs = join(root, 'openspec/changes/feature'); mkdirSync(join(docs, 'specs/test'), { recursive: true }); mkdirSync(join(docs, 'source-ideas'));
  for (const file of ['proposal.md', 'design.md', 'tasks.md', 'specs/test/spec.md']) writeFileSync(join(docs, file), file === 'tasks.md' ? '- [ ] task\n' : '# plan\n');
  writeFileSync(join(docs, '.openspec.yaml'), 'schema: spec-driven\n'); writeFileSync(join(docs, 'source-ideas/idea.md'), '# idea\n');
  const work = { changeName: 'feature', phase: 'implementation', reviewedVersion: 'legacy-reviewed', workspace: { kind: 'git-worktree' } } as Work;
  work.workspace!.sourcePlanRevision = fullReviewedPlan(work, root);
  expect(bindReviewedPlan(work, root, 'legacy-reviewed')).toBe('legacy-reviewed');
  writeFileSync(join(docs, 'tasks.md'), '- [x] task\r\n'); expect(bindReviewedPlan(work, root, 'legacy-reviewed')).toBe('legacy-reviewed');
  for (const file of ['.openspec.yaml', 'source-ideas/idea.md']) {
    writeFileSync(join(docs, file), '# changed\n'); expect(bindReviewedPlan(work, root, 'legacy-reviewed')).not.toBe('legacy-reviewed');
    work.reviewedPlanRevision = fullReviewedPlan(work, root); expect(bindReviewedPlan(work, root, 'legacy-reviewed')).toBe('legacy-reviewed');
    expect(work.reviewedVersion).toBe('legacy-reviewed');
  }
});
