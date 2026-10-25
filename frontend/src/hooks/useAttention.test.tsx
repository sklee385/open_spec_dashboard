import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAttention } from './useAttention';
import { claimAttention } from '../lib/attentionStore';
vi.mock('../lib/attentionStore', () => ({ claimAttention: vi.fn() }));
const item = { workId: 'w', sourceId: 'demo', changeName: 'feature', title: '업무', questionId: 'q', kind: 'input' as const, status: 'pending' as const, createdAt: '2026-10-25T01:00:00Z' };
const settings = { enabled: true, effectiveEnabled: true, dashboardUrl: 'http://localhost:13001/', registrationStatus: 'registered', lastError: null };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
function setup() {
  vi.useFakeTimers(); vi.mocked(claimAttention).mockResolvedValue(true);
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => ({ ok: true, json: async () => url.includes('/notifications/') ? settings : { items: [item] } }));
  vi.stubGlobal('fetch', fetchMock); return fetchMock;
}
it('polls immediately and after completion, preserves items offline, cleans up', async () => {
  const mock = setup(); const view = renderHook(() => useAttention(vi.fn())); await act(async () => {});
  expect(view.result.current.items).toEqual([item]); expect(view.result.current.nativeSettings).toEqual(settings);
  mock.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(view.result.current.connectionError).toBe(true); expect(view.result.current.items).toEqual([item]);
  await act(async () => { window.dispatchEvent(new Event('online')); }); expect(view.result.current.connectionError).toBe(false);
  view.unmount(); const count = mock.mock.calls.length; await act(async () => { await vi.advanceTimersByTimeAsync(10000); window.dispatchEvent(new Event('focus')); }); expect(mock).toHaveBeenCalledTimes(count);
});
it('never uses browser notifications, only saves explicit intent', async () => {
  const mock = setup(); const notification = vi.fn(); const requestPermission = vi.fn(); Object.assign(notification, { requestPermission, permission: 'granted' }); vi.stubGlobal('Notification', notification);
  const view = renderHook(() => useAttention(vi.fn())); await act(async () => {});
  expect(mock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  await act(async () => { await view.result.current.updateWindows({ enabled: false }); });
  expect(mock).toHaveBeenCalledWith('/api/notifications/settings', expect.objectContaining({ method: 'PUT', body: '{"enabled":false}' }));
  expect(notification).not.toHaveBeenCalled(); expect(requestPermission).not.toHaveBeenCalled(); view.unmount();
});
it('IndexedDB failure does not block native status or mutate native settings', async () => {
  const mock = setup(); vi.mocked(claimAttention).mockRejectedValue(new Error('quota'));
  const view = renderHook(() => useAttention(vi.fn())); await act(async () => {});
  expect(view.result.current.storageError).toBe(true); expect(view.result.current.nativeSettings?.effectiveEnabled).toBe(true); expect(view.result.current.items).toEqual([item]);
  expect(mock.mock.calls.every(([, init]) => !init?.method)).toBe(true); view.unmount();
});
it('does not overlap and starts next poll five seconds after completion', async () => {
  const mock = setup(); let resolve!: (value: any) => void; mock.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  const view = renderHook(() => useAttention(vi.fn())); await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(1000); }); expect(mock).toHaveBeenCalledTimes(1);
  await act(async () => { resolve({ ok: true, json: async () => ({ items: [item] }) }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(4999); }); expect(mock).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(mock).toHaveBeenCalledTimes(4); view.unmount();
});
it('does not extend temporary notice timeout on duplicate polls', async () => {
  setup(); const view = renderHook(() => useAttention(vi.fn())); await act(async () => {}); vi.mocked(claimAttention).mockResolvedValue(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(view.result.current.notices).toHaveLength(0); expect(view.result.current.items).toHaveLength(1); view.unmount();
});
