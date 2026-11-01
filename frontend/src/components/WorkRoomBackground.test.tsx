import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { render } from '../test/render';
import { WorkRoom } from './WorkRoom';
import type { WorkRoomNavigation } from '../lib/attentionNavigation';
import type { Change } from '../types';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
let serial = 0;
function fixture(staleBeforeAck = false) {
  const prefix = `background-${++serial}`, a = `${prefix}-a`, b = `${prefix}-b`;
  const work = (id: string) => ({ id, phase: 'reviewed', state: 'idle', reviewedVersion: 'v1', threadId: null, documents: ['proposal.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] });
  let running = false, acknowledged = false, finish!: (error?: Error) => void;
  const response = (value: unknown) => ({ ok: true, json: async () => value });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `/api/work/${a}/action` && init?.method === 'POST') { running = true; return new Promise((resolve,reject) => { finish = error => { acknowledged = true; if(error)reject(error);else resolve(response({ accepted: true })); }; }); }
    if (url === `/api/work/${a}`) { const observed = running && (!staleBeforeAck || acknowledged); return response({ ...work(a), phase: observed ? 'implementation' : 'reviewed', state: observed ? 'running' : 'idle', turnId: observed ? 'synthetic-turn' : undefined }); }
    if (url === `/api/work/${b}`) return response(work(b));
    if (url.includes('/document?')) return response({ path: 'proposal.md', content: url.includes(a) ? 'Synthetic A document' : 'Synthetic B document', version: 'v1' });
    return response(url.endsWith('/workspace') ? { experimentalEnabled: false } : { items: [], errors: [], documentVersions: {} });
  }); vi.stubGlobal('fetch', fetcher);
  const change = (id: string) => ({ id: `fixture/${id}`, sourceId: 'fixture', name: id, title: id } as Change);
  return { a, b, change, fetcher, finish: (error?: Error) => finish(error), running: () => running };
}
it('allows board navigation and draft preservation while implementation acknowledgement is pending, without cancelling or duplicating the job', async () => {
  const f = fixture(), close = vi.fn(), navigation = createRef<WorkRoomNavigation>();
  let view!: ReturnType<typeof render>; await act(async () => { view = render(<WorkRoom change={f.change(f.a)} workId={f.a} onClose={close} navigationRef={navigation} />); });
  await editDocument();
  act(() => { const button = screen.getByRole('button', { name: '구현 시작' }); button.click(); button.click(); });
  expect(f.fetcher.mock.calls.filter(([url]) => url.endsWith('/action'))).toHaveLength(1);
  expect(screen.getByRole('button', { name: '구현 시작' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '← 보드로 돌아가기' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: '문서 내용' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: 'Unsaved chat draft' } });
  expect(navigation.current?.preserveDrafts()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '← 보드로 돌아가기' })); expect(close).toHaveBeenCalledOnce();
  view.unmount(); await act(async () => f.finish()); expect(f.running()).toBe(true);
  const posts = f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'); expect(posts).toHaveLength(1); expect(posts[0][1]?.signal).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(`work-chat-draft:fixture/${f.a}`)!)).toMatchObject({ message: 'Unsaved chat draft' });
});
it('retains the per-work duplicate guard across unmount and reconciles the current viewer when the delayed acknowledgement arrives', async () => {
  const f = fixture(true); let first!: ReturnType<typeof render>;
  await act(async () => { first = render(<WorkRoom change={f.change(f.a)} workId={f.a} onClose={() => {}} />); });
  act(() => fireEvent.click(screen.getByRole('button', { name: '구현 시작' }))); first.unmount();
  await act(async () => { render(<WorkRoom change={f.change(f.a)} workId={f.a} onClose={() => {}} />); });
  expect(screen.getByRole('button', { name: '구현 시작' })).toBeDisabled(); expect(screen.getByRole('button', { name: '← 보드로 돌아가기' })).toBeEnabled();
  await act(async () => f.finish());
  expect(screen.getByRole('button', { name: '구현 시작' })).toBeDisabled(); expect(f.fetcher.mock.calls.filter(([url]) => url.endsWith('/action'))).toHaveLength(1);
});
it('does not leak an old work request failure into the newly selected work or automatically resubmit', async () => {
  const f = fixture(); let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<WorkRoom change={f.change(f.a)} workId={f.a} onClose={() => {}} />); });
  act(() => fireEvent.click(screen.getByRole('button', { name: '구현 시작' })));
  await act(async () => view.rerender(<WorkRoom change={f.change(f.b)} workId={f.b} onClose={() => {}} />));
  await act(async () => f.finish(Error('Old synthetic transport failure')));
  await editDocument();
  expect(screen.queryByText('Old synthetic transport failure')).not.toBeInTheDocument(); expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue('Synthetic B document');
  expect(f.fetcher.mock.calls.filter(([url]) => url.endsWith('/action'))).toHaveLength(1);
});
it('keeps another work editable after navigation and ignores the previous acknowledgement; return reads the actual running state', async () => {
  const f = fixture(); let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<WorkRoom change={f.change(f.a)} workId={f.a} onClose={() => {}} />); });
  act(() => fireEvent.click(screen.getByRole('button', { name: '구현 시작' })));
  await act(async () => view.rerender(<WorkRoom change={f.change(f.b)} workId={f.b} onClose={() => {}} />));
  await editDocument();
  expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue('Synthetic B document'); expect(screen.getByRole('textbox', { name: '문서 내용' })).toBeEnabled();
  await act(async () => f.finish());
  expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue('Synthetic B document');
  await act(async () => view.rerender(<WorkRoom change={f.change(f.a)} workId={f.a} onClose={() => {}} />));
  await editDocument();
  expect(screen.getByRole('button', { name: '구현 시작' })).toBeDisabled(); expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue('Synthetic A document');
});
async function editDocument() {
  fireEvent.click(await screen.findByRole('button', { name: '편집' }));
  return screen.findByRole('textbox', { name: '문서 내용' });
}
