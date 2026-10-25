import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSSE } from './useApi';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('재접속 시 보드를 다시 조회하고 구독 해제 때 연결을 닫는다', () => {
  class Stream {
    static instance: Stream; callbacks: Record<string, () => void> = {}; close = vi.fn(); onerror?: () => void;
    constructor() { Stream.instance = this; }
    addEventListener(name: string, callback: () => void) { this.callbacks[name] = callback; }
  }
  vi.stubGlobal('EventSource', Stream); const update = vi.fn(); const { result, unmount } = renderHook(() => useSSE(update));
  act(() => Stream.instance.callbacks.open()); expect(update).toHaveBeenCalledTimes(1); expect(result.current.connectionStatus).toBe('connected');
  act(() => Stream.instance.callbacks.open()); expect(update).toHaveBeenCalledTimes(2);
  unmount(); expect(Stream.instance.close).toHaveBeenCalledTimes(1);
});
it('실시간 이벤트 누락 시 주기 조회로 복구하고 해제 후 조회를 멈춘다', async () => {
  vi.useFakeTimers();
  class Stream { addEventListener() {} close() {} }
  vi.stubGlobal('EventSource', Stream); const update = vi.fn(); const { unmount } = renderHook(() => useSSE(update));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(update).toHaveBeenCalledTimes(1);
  unmount(); await vi.advanceTimersByTimeAsync(10000); expect(update).toHaveBeenCalledTimes(1);
});
