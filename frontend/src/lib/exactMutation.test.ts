import { beforeEach, expect, it, vi } from 'vitest';
import { exactMutation, readExactMutation } from './exactMutation';
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it('persists a local receipt before sending a strict control payload without injecting a request key', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => { expect(readExactMutation('control')?.body).toEqual({ runId: 'run' }); expect(JSON.parse(String(init?.body))).toEqual({ runId: 'run' }); return { ok: true, json: async () => ({ status: 'cancelled', processTerminated: true }) }; }); vi.stubGlobal('fetch', fetcher);
  await exactMutation('control', '/api/work/w/integration/c/verification/cancel', { runId: 'run' });
  expect(readExactMutation('control')).toMatchObject({ localId: expect.any(String), state: 'completed', body: { runId: 'run' } });
});
it('keeps nested uncertain reconciliation unresolved and retries the exact stored body', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reconciled: false, receipt: { status: 'uncertain', requestKey: 'existing' }, live: { state: 'unknown' }, observation: { state: 'uncertain' } }) }); vi.stubGlobal('fetch', fetcher);
  await exactMutation('recovery', '/api/work/w/integration/c/apply/reconcile', { requestKey: 'existing', confirmed: true });
  expect(readExactMutation('recovery')?.state).toBe('uncertain'); await exactMutation('recovery'); expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]);
});
