import { describe, expect, it } from 'vitest';
import { extractReviewItems } from '../src/review/review-items';
import { readFileSync } from 'node:fs';

describe('명시적 검토 항목 추출', () => {
  it('공개 안내의 실제 예제 네 개만 추출한다', async () => {
    const items = await extractReviewItems('docs/document-review.md', readFileSync('../docs/document-review.md', 'utf8'));
    expect(items.map(x => x.kind)).toEqual(['confirm', 'assumption', 'decision', 'choice']);
  });
  it('네 종류와 여러 줄 하위 블록 및 원문 위치를 보존한다', async () => {
    const content = '# 계획\n\n- [review:confirm] 확인\n  이어지는 본문\n  - 하위 선택지\n- [review:assumption] 가정\n1. [review:decision] 결정\n2. [review:choice] 선택\n';
    const items = await extractReviewItems('proposal.md', content);
    expect(items.map(x => x.kind)).toEqual(['confirm', 'assumption', 'decision', 'choice']);
    expect(items[0]).toMatchObject({ path: 'proposal.md', startLine: 3, endLine: 5 });
    expect(items[0].text).toContain('하위 선택지');
    expect(items[0].version).toMatch(/^[a-f0-9]{64}$/);
    expect((await extractReviewItems('proposal.md', content))[0].id).toBe(items[0].id);
    expect((await extractReviewItems('proposal.md', '\n' + content))[0].id).not.toBe(items[0].id);
  });
  it('코드·인라인 코드·주석·체크박스·일반 문장에서 추측하지 않는다', async () => {
    const content = '```md\n- [review:confirm] 예제\n```\n\n    - [review:choice] 들여쓰기 코드\n\n<!--\n- [review:decision] 주석\n-->\n\n- `[review:confirm]` 인라인\n- [ ] 작업\n- [x] 완료\n[review:confirm] 문단\n- [review:unknown] 미지원\n- [review:confirm] 실제 <!-- 숨긴 내용 --> 본문\n';
    const items = await extractReviewItems('design.md', content);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('실제  본문');
  });
  it('중첩 항목도 문서 순서대로 추출한다', async () => {
    const items = await extractReviewItems('tasks.md', '- 일반\n  - [review:confirm] 중첩 확인\n\n- [review:decision] 마지막\n');
    expect(items.map(x => x.text)).toEqual(['중첩 확인', '마지막']);
  });
});
