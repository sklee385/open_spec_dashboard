import { afterEach, expect, it, vi } from 'vitest';
import { loadAttentionDestination, parseAttentionLink } from './attentionNavigation';
const item = { workId: 'w', sourceId: 'old', changeName: 'old', title: '업무', questionId: 'q', kind: 'input' as const, status: 'pending' as const, createdAt: '' };
afterEach(() => vi.unstubAllGlobals());
it('parses identifiers and rejects partial, duplicate or empty parameters', () => {
  expect(parseAttentionLink('http://localhost/?workId=w%26x&questionId=q%23z')).toEqual({ workId: 'w&x', questionId: 'q#z' });
  expect(parseAttentionLink('http://localhost/?other=x')).toBeNull();
  for (const query of ['workId=w', 'questionId=q', 'workId=&questionId=q', 'workId=w&workId=x&questionId=q', 'workId=%00&questionId=q']) expect(() => parseAttentionLink(`http://localhost/?${query}`)).toThrow();
});
it('필터와 알림의 오래된 메타데이터 대신 최신 업무 식별자로 정확한 변경을 확인한다', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'w', sourceId: 'demo', changeName: 'feature', questions: [{ id: 'q' }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'demo/feature', sourceId: 'demo', name: 'feature', title: '원본 업무', status: 'draft', proposal: 'p', design: null, specs: [], tasks: null, schema: 'spec-driven', artifacts: [] }) });
  vi.stubGlobal('fetch', fetchMock);
  expect(await loadAttentionDestination(item)).toMatchObject({ id: 'demo/feature', name: 'feature', title: '원본 업무', hasProposal: true });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/work/w', '/api/changes/demo%2Ffeature']);
});
it('제거된 프로젝트·업무·변경을 임의의 다른 대상으로 대체하지 않는다', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false }); vi.stubGlobal('fetch', fetchMock);
  await expect(loadAttentionDestination(item)).rejects.toThrow(); expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'w', sourceId: 'demo', changeName: 'feature' }) });
  await expect(loadAttentionDestination(item)).rejects.toThrow();
});
it('rejects a missing request before switching to a different work', async () => {
  const mock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'w', sourceId: 'demo', changeName: 'feature', questions: [] }) }); vi.stubGlobal('fetch', mock);
  await expect(loadAttentionDestination(item)).rejects.toThrow('Request unavailable'); expect(mock).toHaveBeenCalledTimes(1);
});
