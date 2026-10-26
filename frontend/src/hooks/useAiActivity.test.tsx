import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAiActivity } from './useAiActivity';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('실제 업무의 실행 수와 상태를 갱신하고 조회 실패 시 오래된 실행 표시를 지운다', async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ work: [
    { sourceId: 'a', changeName: 'one', state: 'running' },
    { sourceId: 'a', changeName: 'two', state: 'waiting-input' },
  ] }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ work: [
    { sourceId: 'a', changeName: 'one', state: 'idle' },
    { sourceId: 'a', changeName: 'two', state: 'waiting-input' },
  ] }) }).mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  const view = renderHook(useAiActivity);
  await act(async () => {});
  expect(view.result.current.count).toBe(1);
  expect(view.result.current.byChange.get('a/one')).toBe('running');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(view.result.current.state).toBe('waiting-input');
  expect(view.result.current.count).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(view.result.current.state).toBeUndefined();
  expect(view.result.current.byChange.size).toBe(0);
  view.unmount();
});
