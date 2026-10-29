import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useReadRequests } from './useReadRequests';
import { useCoalescedRefresh } from './useCoalescedRefresh';
afterEach(() => vi.useRealTimers());
it('aborts a stalled read at 30 seconds and allows the queued latest reload to finish', async () => {
  vi.useFakeTimers(); let signal!: AbortSignal;
  const network = vi.fn().mockImplementationOnce((value: AbortSignal) => { signal = value; return new Promise((_resolve, reject) => value.addEventListener('abort', () => reject(new Error('read timeout')))); }).mockResolvedValue('latest');
  const view = renderHook(() => { const read = useReadRequests(); return useCoalescedRefresh(() => read(network)); });
  let first!: Promise<unknown>, latest!: Promise<unknown>;
  await act(async () => { first = view.result.current().catch(error => error); latest = view.result.current(); });
  expect(network).toHaveBeenCalledTimes(1); await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(signal.aborted).toBe(true); expect(await first).toMatchObject({ message: 'read timeout' }); expect(await latest).toBe('latest'); expect(network).toHaveBeenCalledTimes(2);
});
it('aborts an active read and drops its queued reload on unmount', async () => {
  let signal!: AbortSignal; const network = vi.fn((value: AbortSignal) => { signal = value; return new Promise((_resolve, reject) => value.addEventListener('abort', () => reject(new Error('unmounted')))); });
  const view = renderHook(() => { const read = useReadRequests(); return useCoalescedRefresh(() => read(network)); });
  const first = view.result.current().catch(error => error); const queued = view.result.current().catch(error => error); view.unmount(); await Promise.all([first, queued]);
  expect(signal.aborted).toBe(true); expect(network).toHaveBeenCalledTimes(1);
});
