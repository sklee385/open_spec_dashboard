import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { durableMutation, readMutation, recoverWorkspace } from './workspaceFlowApi';

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
afterEach(() => { delete window.desktopDrafts; });
it('persists exact endpoint and payload before sending and replays a lost reply with the same key', async () => {
  const fetcher = vi.fn().mockImplementationOnce(() => { expect(readMutation('work')?.body).toEqual({ confirmed: true, requestKey: expect.any(String) }); throw new Error('lost'); }).mockResolvedValue({ ok: true, json: async () => ({ status: 'ready' }) });
  vi.stubGlobal('fetch', fetcher);
  await expect(durableMutation('work', '/api/work/a/workspace/prepare', { confirmed: true })).rejects.toThrow('lost');
  const original = readMutation('work');
  expect(original?.state).toBe('uncertain');
  await durableMutation('work');
  expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
  expect(readMutation('work')?.state).toBe('completed');
});
it('does not send when persistent storage fails', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage'); });
  await expect(durableMutation('work', '/api/example', {})).rejects.toThrow('storage');
  expect(fetcher).not.toHaveBeenCalled();
});
it('blocks replacing an unresolved request with a different body', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('lost')));
  await expect(durableMutation('work', '/api/a', { paths: ['a'] })).rejects.toThrow('lost');
  await expect(durableMutation('work', '/api/a', { paths: ['b'] })).rejects.toThrow();
});
it('only treats typed rejection before intent as a known failure', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({ ok: false, status: 409, json: async () => ({ message: 'stale', mutationOutcome: 'rejected-before-intent', requestKey: readMutation('work')?.body.requestKey }) })));
  await expect(durableMutation('work', '/api/a', {})).rejects.toThrow('stale'); expect(readMutation('work')?.state).toBe('failed');
});
it('renews only the confirmation token using the saved preparation key and immutable policy', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue({ ok: true, json: async () => ({ status: 'ready' }) }); vi.stubGlobal('fetch', fetcher);
  await expect(durableMutation('work', '/api/work/a/workspace/prepare', { previewToken: 'old', selectedBranch: 'main', policy: { runtime: 'none' } })).rejects.toThrow();
  const before = readMutation('work'); await recoverWorkspace('work', 'renewed');
  const after = readMutation('work'); expect(after?.endpoint).toBe('/api/work/a/workspace/recover');
  expect(after?.body).toEqual({ ...before?.body, previewToken: 'renewed' }); expect(after?.state).toBe('completed');
});
it('retains uncertainty for a typed rejection echoing an unrelated key', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ mutationOutcome: 'rejected-before-intent', requestKey: 'other' }) }));
  await expect(durableMutation('work', '/api/a', {})).rejects.toThrow(); expect(readMutation('work')?.state).toBe('uncertain');
});
it.each(['typed-rejection', 'success'] as const)('preserves a newer recovery attempt when an old preparation returns %s', async outcome => {
  let finishA!: (value: unknown) => void, rejectB!: (error: Error) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; })).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectB = reject; })));
  const first = durableMutation('work', '/api/work/a/workspace/prepare', { previewToken: 'old', policy: { runtime: 'node' } }).then(() => null, error => error);
  await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
  const original = readMutation('work');
  const recovery = recoverWorkspace('work', 'new').then(() => null, error => error);
  await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
  const renewed = readMutation('work');
  expect(renewed?.attemptId).not.toBe(original?.attemptId);
  finishA({ ok: outcome === 'success', status: outcome === 'success' ? 200 : 409, json: async () => outcome === 'success' ? { status: 'ready' } : { message: 'stale', mutationOutcome: 'rejected-before-intent', requestKey: original?.body.requestKey } });
  expect(await first).toMatchObject({ name: 'SupersededMutationError' });
  expect(readMutation('work')).toEqual(renewed);
  rejectB(new Error('recovery lost')); await recovery;
  expect(readMutation('work')).toMatchObject({ endpoint: '/api/work/a/workspace/recover', body: { previewToken: 'new', requestKey: original?.body.requestKey }, state: 'uncertain', attemptId: renewed?.attemptId });
});
it('does not replace a completed recovery receipt with a late preparation success', async () => {
  let finishA!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; })).mockResolvedValue({ ok: true, json: async () => ({ status: 'ready', branch: 'newer' }) }));
  const first = durableMutation('work', '/api/work/a/workspace/prepare', { previewToken: 'old' }).then(() => null, error => error);
  await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
  await recoverWorkspace('work', 'new'); const newer = readMutation('work');
  finishA({ ok: true, json: async () => ({ status: 'ready', branch: 'older' }) }); await first;
  expect(readMutation('work')).toEqual(newer);
});
it('restores an old receipt through desktop profile storage and assigns a new attempt only on explicit retry', async () => {
  const values = new Map<string, string>(); window.desktopDrafts = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  values.set('workspace-mutation:work', JSON.stringify({ endpoint: '/api/work/a/workspace/prepare', body: { requestKey: 'legacy-key', previewToken: 'old' }, state: 'uncertain', createdAt: 'before' }));
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ready' }) }); vi.stubGlobal('fetch', fetcher);
  expect(readMutation('work')?.attemptId).toBeUndefined(); expect(fetcher).not.toHaveBeenCalled();
  await durableMutation('work'); expect(readMutation('work')).toMatchObject({ attemptId: expect.any(String), body: { requestKey: 'legacy-key', previewToken: 'old' }, state: 'completed' });
  expect(JSON.parse(values.get('workspace-mutation:work')!)).toMatchObject({ attemptId: expect.any(String), body: { requestKey: 'legacy-key' } });
});
it('assigns distinct attempts to identical-key identical-body retries and ignores the older reply', async () => {
  let finishA!: (value: unknown) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; })).mockResolvedValue({ ok: true, json: async () => ({ status: 'ready' }) }); vi.stubGlobal('fetch', fetcher);
  const first = durableMutation('work', '/api/work/a/workspace/prepare', { confirmed: true }).then(() => null, error => error);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); const before = readMutation('work'); await durableMutation('work'); const newer = readMutation('work');
  expect(newer?.attemptId).not.toBe(before?.attemptId); expect(newer?.body).toEqual(before?.body); expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
  finishA({ ok: true, json: async () => ({ status: 'ready', source: 'old' }) }); expect(await first).toMatchObject({ name: 'SupersededMutationError' }); expect(readMutation('work')).toEqual(newer);
});
it.each(['read', 'write'])('does not send when desktop profile %s fails', async failure => {
  window.desktopDrafts = { getItem: () => { if (failure === 'read') throw new Error('profile read'); return null; }, setItem: () => { throw new Error('profile write'); }, removeItem: () => {} };
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); await expect(durableMutation('work', '/api/work/a/workspace/prepare', {})).rejects.toThrow(`profile ${failure}`); expect(fetcher).not.toHaveBeenCalled();
});
it('releases the same-origin storage lock before network waits and permits an explicit recovery', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks'); let held = false, finishA!: (value: unknown) => void;
  const request = vi.fn(async (_name: string, _options: unknown, action: () => unknown) => { expect(held).toBe(false); held = true; try { return await action(); } finally { held = false; } });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
  try {
    const fetcher = vi.fn().mockImplementationOnce(() => { expect(held).toBe(false); return new Promise(resolve => { finishA = resolve; }); }).mockImplementation(async () => { expect(held).toBe(false); return { ok: true, json: async () => ({ status: 'ready' }) }; }); vi.stubGlobal('fetch', fetcher);
    const first = durableMutation('work', '/api/work/a/workspace/prepare', { previewToken: 'old' }).then(() => null, error => error);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); expect(held).toBe(false); await recoverWorkspace('work', 'new');
    finishA({ ok: true, json: async () => ({ status: 'ready' }) }); expect(await first).toMatchObject({ name: 'SupersededMutationError' });
    expect(request).toHaveBeenCalledTimes(4); expect(readMutation('work')).toMatchObject({ endpoint: '/api/work/a/workspace/recover', state: 'completed' });
  } finally { if (original) Object.defineProperty(navigator, 'locks', original); else Reflect.deleteProperty(navigator, 'locks'); }
});
it('does not recover a different receipt than the policy snapshot the user confirmed', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ mutationOutcome: 'rejected-before-intent', requestKey: readMutation('work')?.body.requestKey }) }).mockResolvedValue({ ok: true, json: async () => ({ status: 'ready' }) }); vi.stubGlobal('fetch', fetcher);
  await expect(durableMutation('work', '/api/work/a/workspace/prepare', { previewToken: 'old', policy: { runtime: 'none' } })).rejects.toThrow(); const displayed = readMutation('work');
  await durableMutation('work', '/api/work/a/workspace/prepare', { previewToken: 'different', policy: { runtime: 'node' } }); const latest = readMutation('work');
  await expect(recoverWorkspace('work', 'renewed', displayed)).rejects.toMatchObject({ name: 'SupersededMutationError' }); expect(fetcher).toHaveBeenCalledTimes(2); expect(readMutation('work')).toEqual(latest);
});
