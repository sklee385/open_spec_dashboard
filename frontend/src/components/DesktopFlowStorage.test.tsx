import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '../test/render';
import { WorkspacePreparation } from './WorkspacePreparation';
import { durableMutation, readMutation } from '../lib/workspaceFlowApi';
import { exactMutation, readExactMutation } from '../lib/exactMutation';
import { draftStorage } from '../lib/draftStorage';

const { DraftStore } = createRequire(import.meta.url)('../../../desktop/drafts.cjs');
let directory: string;
const reopen = () => {
  const store = new DraftStore(directory);
  window.desktopDrafts = { getItem: key => store.request('get', key), setItem: (key, value) => store.request('set', key, value), removeItem: key => store.request('remove', key) };
};
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'desktop-flow-')); localStorage.clear(); reopen(); });
afterEach(() => { delete window.desktopDrafts; rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('does not display a persistence failure when the disabled workspace panel saves through the desktop store', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ experimentalEnabled: false }) })));
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<WorkspacePreparation workId="fixture" />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(450); });
  expect(screen.queryByText('요청 또는 초안을 보존할 수 없습니다. 새 요청을 전송하지 않았습니다.')).toBeNull();
  expect(draftStorage.getItem('workspace-preparation-draft:fixture')).not.toBeNull();
  view.unmount(); reopen();
  expect(draftStorage.getItem('workspace-preparation-draft:fixture')).not.toBeNull();
});

it('persists real flow/control receipts before HTTP and restores unresolved requests without automatic resend', async () => {
  const fetcher = vi.fn(async (url: string) => {
    const saved = url.endsWith('/prepare') ? readMutation('workspace:w') : readExactMutation('browser:w');
    expect(saved?.state).toBe('uncertain');
    throw new Error('reply lost');
  });
  vi.stubGlobal('fetch', fetcher);
  await expect(durableMutation('workspace:w', '/api/work/w/workspace/prepare', { policy: { runtime: 'none' } })).rejects.toThrow('reply lost');
  await expect(exactMutation('browser:w', '/api/work/w/browser/run', { requestKey: 'browser-request' })).rejects.toThrow('reply lost');
  const original = readMutation('workspace:w'), control = readExactMutation('browser:w');
  reopen();
  expect(readMutation('workspace:w')).toEqual(original); expect(readExactMutation('browser:w')).toEqual(control);
  await expect(durableMutation('workspace:w', '/api/work/w/workspace/prepare', {})).rejects.toThrow('Resolve');
  await expect(exactMutation('browser:w', '/api/work/w/browser/run', {})).rejects.toThrow('Inspect');
  expect(fetcher).toHaveBeenCalledTimes(2);
  await expect(durableMutation('workspace:w')).rejects.toThrow('reply lost');
  expect(readMutation('workspace:w')?.body).toEqual(original?.body);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
