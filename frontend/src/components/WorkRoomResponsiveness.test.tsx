import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { WorkRoom } from './WorkRoom';
import type { Change } from '../types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const work = { id: 'work-1', phase: 'planning', state: 'idle', threadId: null, reviewedVersion: null, documents: ['proposal.md', 'tasks.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] };
const response = (data: unknown) => ({ ok: true, json: async () => data });
async function fixture() {
  let holdReads = false, holdMutation = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/action') && init?.method === 'POST' && holdMutation) return new Promise<never>(() => {});
    if (holdReads && (url.includes('path=tasks.md') || url === '/api/work/work-1')) return new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError'))));
    return response(url.includes('/document?') ? { path: url.includes('tasks.md') ? 'tasks.md' : 'proposal.md', content: 'synthetic', version: 'v1' } : url === '/api/work/work-1' ? work : url.endsWith('/workspace') ? { experimentalEnabled: false } : { items: [], errors: [], documentVersions: {} });
  });
  vi.stubGlobal('fetch', fetcher);
  const close = vi.fn();
  await act(async () => { render(<WorkRoom change={{ id: 'demo/feature', sourceId: 'demo', name: 'feature' } as Change} workId="work-1" onClose={close} />); });
  return { fetcher, close, holdReads: () => { holdReads = true; }, holdMutation: () => { holdMutation = true; } };
}
it('keeps unrelated actions and board navigation responsive while opening a slow document', async () => {
  const f = await fixture(); f.holdReads();
  await act(async () => fireEvent.change(screen.getByRole('combobox', { name: '문서 선택' }), { target: { value: 'tasks.md' } }));
  expect(screen.getByRole('button', { name: 'AI와 계획 작성·수정' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '← 보드로 돌아가기' }));
  expect(f.close).toHaveBeenCalledOnce();
});
it('lets the user leave after a committed action while its state refresh is slow, without resubmitting it', async () => {
  const f = await fixture(); f.holdReads();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'AI와 계획 작성·수정' })));
  fireEvent.click(screen.getByRole('button', { name: 'AI와 계획 작성·수정' }));
  expect(f.fetcher.mock.calls.filter(([url]) => url.endsWith('/action'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '← 보드로 돌아가기' }));
  expect(f.close).toHaveBeenCalledOnce();
});
it('does not dispatch duplicate mutations in the same event turn', async () => {
  const f = await fixture(); f.holdMutation();
  act(() => { const button = screen.getByRole('button', { name: 'AI와 계획 작성·수정' }); button.click(); button.click(); });
  expect(f.fetcher.mock.calls.filter(([url]) => url.endsWith('/action'))).toHaveLength(1);
});
it('cancels only a pending document read and preserves the displayed document and its editable draft', async () => {
  const f = await fixture(); f.holdReads();
  await act(async () => fireEvent.change(screen.getByRole('combobox', { name: '문서 선택' }), { target: { value: 'tasks.md' } }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '조회 취소' })));
  expect(screen.queryByRole('button', { name: '조회 취소' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '문서 내용' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue('synthetic');
  expect(f.fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});
