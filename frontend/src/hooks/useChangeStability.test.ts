import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useChange } from './useApi';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('does not display the previous work when its slow response arrives after switching works', async () => {
  const finish = new Map<string, (value: unknown) => void>();
  vi.stubGlobal('fetch', vi.fn((url: string) => new Promise(resolve => finish.set(url, resolve))));
  const view = renderHook(({ id }) => useChange(id), { initialProps: { id: 'fixture/old' } });
  await act(async () => view.rerender({ id: 'fixture/new' }));
  expect(view.result.current.change).toBeNull();
  await act(async () => finish.get('/api/changes/fixture%2Fnew')!({ ok: true, text: async () => JSON.stringify({ id: 'fixture/new', title: 'new synthetic work' }) }));
  expect(view.result.current.change?.id).toBe('fixture/new');
  await act(async () => finish.get('/api/changes/fixture%2Fold')!({ ok: true, text: async () => JSON.stringify({ id: 'fixture/old', title: 'old synthetic work' }) }));
  expect(view.result.current.change?.id).toBe('fixture/new'); expect(view.result.current.loading).toBe(false);
});
