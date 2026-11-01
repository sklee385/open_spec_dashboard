import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { WorkRoom } from './WorkRoom';
import type { Change } from '../types';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const change = { id: 'fixture/documents', sourceId: 'fixture', name: 'documents' } as Change;
const work = { id: 'doc-work', phase: 'planning', state: 'idle', threadId: null, documents: ['proposal.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] };
const response = (data: unknown) => ({ ok: true, json: async () => data });

it('opens clean documents as rendered previews and cannot switch modes before the initial document arrives', async () => {
  let complete!: () => void;
  const held = new Promise(resolve => { complete = () => resolve(response({ path: 'proposal.md', content: '# Preview first', version: 'v1' })); });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/document?') ? held : response(url === '/api/work/doc-work' ? work : { items: [], errors: [] })));
  render(<WorkRoom change={change} workId={work.id} onClose={() => {}} />);
  expect(screen.getByRole('button', { name: '편집' })).toBeDisabled();
  await act(async () => complete());
  expect(await screen.findByRole('heading', { name: 'Preview first' })).toBeVisible();
  expect(screen.queryByRole('textbox', { name: '문서 내용' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '편집' }));
  expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue('# Preview first');
});

it('discovers a new report on refresh, previews it, and restores its unsaved draft as an editor', async () => {
  let documents = work.documents;
  class Stream {
    static current: Stream;
    onopen?: () => void;
    constructor() { Stream.current = this; }
    addEventListener() {}
    close() {}
  }
  vi.stubGlobal('EventSource', Stream);
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes('/document?')) {
      const path = new URL(url, 'http://fixture').searchParams.get('path');
      return response({ path, content: path === 'reports/review.md' ? '# Newly discovered report' : '# Proposal', version: 'v1' });
    }
    return response(url === '/api/work/doc-work' ? { ...work, documents } : { items: [], errors: [], experimentalEnabled: false });
  });
  vi.stubGlobal('fetch', fetcher);
  const first = render(<WorkRoom change={change} workId={work.id} onClose={() => {}} />);
  await screen.findByRole('heading', { name: 'Proposal' });
  documents = [...documents, 'reports/review.md'];
  await act(async () => Stream.current.onopen?.());
  await screen.findByRole('option', { name: 'reports/review.md' });
  fireEvent.change(screen.getByRole('combobox', { name: '문서 선택' }), { target: { value: 'reports/review.md' } });
  await screen.findByRole('heading', { name: 'Newly discovered report' });
  fireEvent.click(screen.getByRole('button', { name: '편집' }));
  fireEvent.change(screen.getByRole('textbox', { name: '문서 내용' }), { target: { value: '# Unsaved report draft' } });
  first.unmount();
  render(<WorkRoom change={change} workId={work.id} onClose={() => {}} />);
  expect(await screen.findByRole('textbox', { name: '문서 내용' })).toHaveValue('# Unsaved report draft');
  expect(screen.getByRole('combobox', { name: '문서 선택' })).toHaveValue('reports/review.md');
  expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});
