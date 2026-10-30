import { beforeEach, expect, it, vi } from 'vitest';
import { exactMutation, observeExactMutation, readExactMutation } from './exactMutation';
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

it('rejects mismatched or unconfirmed observations and never settles a newer request attempt', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'running' }) })));
  await exactMutation('observed', '/api/work/w/integration/c/apply', { requestKey: 'key', expectedVersion: 'version', confirmed: true });
  const saved = readExactMutation('observed')!;
  const row = { workId: 'w', candidateId: 'c', requestKey: 'key', expectedVersion: 'version', status: 'applied', processTerminated: true };
  for (const change of [{ workId: 'other' }, { candidateId: 'other' }, { requestKey: 'other' }, { expectedVersion: 'other' }, { processTerminated: false }, { status: 'uncertain' }]) {
    expect(await observeExactMutation('observed', saved, { ...row, ...change }, 'settled')).toBeNull(); expect(readExactMutation('observed')).toEqual(saved);
  }
  expect(await observeExactMutation('observed', saved, row, 'unknown')).toBeNull();
  await exactMutation('observed'); const newer = readExactMutation('observed')!;
  expect(await observeExactMutation('observed', saved, row, 'settled')).toBeNull(); expect(readExactMutation('observed')).toEqual(newer);
  expect(await observeExactMutation('observed', newer, row, 'settled')).toMatchObject({ state: 'completed' });
});
it('restores a remounted uncertain view after the same attempt already finished in storage', async () => {
  let initial: ReturnType<typeof readExactMutation> = null;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'applied' }) })));
  await exactMutation('remounted', '/api/work/w/integration/c/apply', { requestKey: 'key', expectedVersion: 'version' }, value => { initial = { ...value }; });
  expect(initial).toMatchObject({ state: 'uncertain' }); expect(readExactMutation('remounted')?.state).toBe('completed');
  const observed = await observeExactMutation('remounted', initial, { workId: 'w', candidateId: 'c', requestKey: 'key', expectedVersion: 'version', status: 'applied', processTerminated: true }, 'settled');
  expect(observed).toMatchObject({ state: 'completed' });
});
it('브라우저 수락은 같은 업무·후보·사용자 요청만 확인하며 검증 통과나 종료로 바꾸지 않는다', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'running' }) })));
  await exactMutation('browser-accept', '/api/work/w/integration/c/browser/run', { requestKey: 'key' });
  const saved = readExactMutation('browser-accept')!;
  const row = { workId: 'w', candidateId: 'c', id: 'run', owner: 'user', requestKey: 'key', status: 'running', processTerminated: false };
  for (const change of [{ workId: 'other' }, { candidateId: null }, { owner: 'tool' }, { requestKey: 'other' }, { status: 'unknown' }]) {
    expect(await observeExactMutation('browser-accept', saved, { ...row, ...change })).toBeNull();
    expect(readExactMutation('browser-accept')).toEqual(saved);
  }
  expect(await observeExactMutation('browser-accept', saved, row)).toMatchObject({ state: 'completed', response: { observed: true, receipt: { status: 'running', processTerminated: false } } });
});
