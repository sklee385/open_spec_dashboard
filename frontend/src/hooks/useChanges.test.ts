import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useChanges } from './useApi';
afterEach(() => vi.unstubAllGlobals());
it('실행 중인 이전 서버에서도 저장된 업무 출처로 아이디어 제목을 복원한다', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, text: async () => JSON.stringify(url === '/api/changes' ? { changes: [{ id: 'demo/idea-123', name: 'idea-123', sourceId: 'demo', status: 'draft' }] } : url === '/api/work' ? { work: [{ id: 'work-1', sourceId: 'demo', changeName: 'idea-123' }] } : { events: [{ type: 'source-idea', data: { title: '다국어처리' } }] }) })));
  const { result } = renderHook(() => useChanges()); await waitFor(() => expect(result.current.changes[0]?.title).toBe('다국어처리'));
});
it('제목 복구 API가 실패해도 업무 카드를 누락시키지 않는다', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: url === '/api/changes', status: 404, text: async () => JSON.stringify(url === '/api/changes' ? { changes: [{ id: 'demo/idea-123', name: 'idea-123', sourceId: 'demo', status: 'draft' }] } : { error: 'Not found' }) })));
  const { result } = renderHook(() => useChanges()); await waitFor(() => expect(result.current.changes[0]?.id).toBe('demo/idea-123')); expect(result.current.error).toBeNull();
});
