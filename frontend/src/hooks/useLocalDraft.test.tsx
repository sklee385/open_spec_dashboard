import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { projectDraftKey, useLocalDraft, workDraftKey } from './useLocalDraft';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('debounces input changes for 400ms and flushes the latest input immediately on unload', () => {
  vi.useFakeTimers();
  const { rerender } = renderHook(({ text }) => useLocalDraft('draft', { text }, true, () => {}), { initialProps: { text: 'first' } });
  act(() => { vi.advanceTimersByTime(300); });
  rerender({ text: 'second' });
  act(() => { vi.advanceTimersByTime(399); });
  expect(localStorage.getItem('draft')).toBeNull();
  act(() => { vi.advanceTimersByTime(1); });
  expect(JSON.parse(localStorage.getItem('draft')!)).toEqual({ text: 'second' });
  rerender({ text: 'third' });
  act(() => { window.dispatchEvent(new Event('beforeunload')); });
  expect(JSON.parse(localStorage.getItem('draft')!)).toEqual({ text: 'third' });
});

it('blocks unload on storage failure and allows retrying the same pending snapshot', () => {
  const failure = vi.fn();
  const { result } = renderHook(() => useLocalDraft('draft', 'keep', true, failure));
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const event = new Event('beforeunload', { cancelable: true });
  act(() => { window.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
  expect(failure).toHaveBeenCalledOnce();
  write.mockRestore();
  act(() => { expect(result.current.flush()).toBe(true); });
  expect(localStorage.getItem('draft')).toBe('"keep"');
});

it('keeps colon-containing work, project and file identities distinct', () => {
  expect(workDraftKey('a:b', 'c')).not.toBe(workDraftKey('a', 'b:c'));
  expect(projectDraftKey('a:b', 'c', 'd')).not.toBe(projectDraftKey('a', 'b:c', 'd'));
  expect(projectDraftKey('a', 'b', 'c:d')).not.toBe(projectDraftKey('a', 'b:c', 'd'));
  expect(projectDraftKey('a', null, 'file')).not.toBe(projectDraftKey('a', 'null', 'file'));
});
