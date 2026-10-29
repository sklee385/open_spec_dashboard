import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useCoalescedRefresh } from './useCoalescedRefresh';
it('runs one refresh at a time and coalesces intervening requests using the latest callback and arguments', async () => {
  let first!: (value: string) => void, second!: (value: string) => void;
  const run = vi.fn().mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
  const view = renderHook(({ generation }) => useCoalescedRefresh((id: string) => run(generation, id)), { initialProps: { generation: 'old' } });
  let initial!: Promise<unknown>; await act(async () => { initial = view.result.current('one'); });
  view.result.current('two'); view.rerender({ generation: 'new' }); const latest = view.result.current('three');
  expect(run).toHaveBeenCalledTimes(1); await act(async () => first('old-result'));
  expect(run).toHaveBeenCalledTimes(2); expect(run.mock.calls[1]).toEqual(['new', 'three']); expect(await initial).toBe('old-result');
  await act(async () => second('latest-result')); expect(await latest).toBe('latest-result');
});
it('drops queued background refreshes after unmount without replaying a request', async () => {
  let finish!: () => void; const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = renderHook(() => useCoalescedRefresh(run)); let request!: Promise<void>;
  await act(async () => { request = view.result.current(); }); view.result.current(); view.unmount();
  finish(); await request; expect(run).toHaveBeenCalledTimes(1);
});
