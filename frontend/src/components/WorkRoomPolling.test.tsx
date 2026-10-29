import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { WorkRoom } from './WorkRoom';
import type { Change } from '../types';
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('pauses hidden work polling without reinitializing work and refreshes once on return with drafts intact', async () => {
  vi.useFakeTimers(); const change = { id: 'demo/feature', sourceId: 'demo', name: 'feature' } as Change;
  class Stream { static all: Stream[] = []; url: string; callbacks: Record<string, (event: { data: string }) => void> = {}; constructor(url: string) { this.url = url; Stream.all.push(this); } addEventListener(name: string, callback: (event: { data: string }) => void) { this.callbacks[name] = callback; } close() {} }
  vi.stubGlobal('EventSource', Stream); let incomingQuestion = false;
  const work = { id: 'work-1', phase: 'planning', state: 'idle', threadId: null, reviewedVersion: null, documents: ['proposal.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, json: async () => url.includes('/document?') ? { path: 'proposal.md', content: 'server', version: 'v1' } : url.endsWith('/workspace') ? { experimentalEnabled: false } : url === '/api/work' && init?.method === 'POST' || url === '/api/work/work-1' ? { ...work, questions: incomingQuestion ? [{ id: 'hidden-q', kind: 'input', status: 'pending', params: { questions: [{ id: 'choice', question: '숨긴 동안 받은 질문' }] } }] : [] } : { items: [], errors: [], documentVersions: {} } })); vi.stubGlobal('fetch', fetcher);
  let view!: ReturnType<typeof render>; await act(async () => { view = render(<WorkRoom change={change} active onClose={() => {}} />); });
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: 'hidden chat draft' } }); fireEvent.change(screen.getByRole('textbox', { name: '문서 내용' }), { target: { value: 'hidden document draft' } });
  const workReads = () => fetcher.mock.calls.filter(([url]) => url === '/api/work/work-1').length; const before = workReads();
  await act(async () => view.rerender(<WorkRoom change={change} active={false} onClose={() => {}} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(12000); }); expect(workReads()).toBe(before);
  incomingQuestion = true; const stream = Stream.all.find(item => item.url.includes('/work/work-1/events'))!;
  await act(async () => { stream.callbacks['work-update']({ data: JSON.stringify({ seq: 1 }) }); await vi.advanceTimersByTimeAsync(150); }); expect(workReads()).toBe(before + 1); expect(screen.getByRole('textbox', { name: '숨긴 동안 받은 질문' })).toBeVisible();
  await act(async () => view.rerender(<WorkRoom change={change} active onClose={() => {}} />)); expect(workReads()).toBe(before + 2);
  expect(screen.getByRole('textbox', { name: 'AI와 문답' })).toHaveValue('hidden chat draft'); expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue('hidden document draft'); expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('queues notification reads behind a stalled poll while preserving the current document draft', async () => {
  vi.useFakeTimers(); const change = { id: 'demo/feature', sourceId: 'demo', name: 'feature' } as Change;
  const work = { id: 'work-1', phase: 'planning', state: 'idle', threadId: null, reviewedVersion: null, documents: ['proposal.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] };
  let stalled = false, finish!: (value: unknown) => void;
  const response = (value: unknown) => ({ ok: true, json: async () => value });
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/work/work-1') return stalled ? new Promise(resolve => { finish = resolve; }) : response(work);
    return response(url.includes('/document?') ? { path: 'proposal.md', content: 'server', version: 'v1' } : url.endsWith('/workspace') ? { experimentalEnabled: false } : { items: [], errors: [], documentVersions: {} });
  }); vi.stubGlobal('fetch', fetcher);
  let view!: ReturnType<typeof render>; await act(async () => { view = render(<WorkRoom change={change} workId="work-1" onClose={() => {}} />); });
  fireEvent.change(screen.getByRole('textbox', { name: '문서 내용' }), { target: { value: 'keep notification draft' } });
  const reads = () => fetcher.mock.calls.filter(([url]) => url === '/api/work/work-1').length; const baseline = reads();
  stalled = true; await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  await act(async () => view.rerender(<WorkRoom change={change} workId="work-1" attentionTarget={{ workId: 'work-1', questionId: 'notification-q', token: 1 }} onClose={() => {}} />));
  expect(reads()).toBe(baseline + 1);
  stalled = false; await act(async () => finish(response(work)));
  expect(reads()).toBe(baseline + 2); expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue('keep notification draft');
});
it('shares one complete work and document read cycle between interval and SSE refreshes and retains one latest reload', async () => {
  vi.useFakeTimers();
  class Stream {
    static all: Stream[] = []; callbacks: Record<string, (event: { data: string }) => void> = {}; onopen?: () => void;
    url: string;
    constructor(url: string) { this.url = url; Stream.all.push(this); }
    addEventListener(name: string, callback: (event: { data: string }) => void) { this.callbacks[name] = callback; }
    close() {}
  }
  vi.stubGlobal('EventSource', Stream);
  const work = { id: 'work-1', phase: 'planning', state: 'idle', threadId: null, reviewedVersion: null, documents: ['proposal.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] };
  const response = (value: unknown) => ({ ok: true, json: async () => value });
  let blockWork = false, blockDoc = false, finishWork!: (value: unknown) => void, finishDoc!: (value: unknown) => void;
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/work/work-1') { if (blockWork) { blockWork = false; return new Promise(resolve => { finishWork = resolve; }); } return response(work); }
    if (url.includes('/document?')) { if (blockDoc) return new Promise(resolve => { finishDoc = resolve; }); return response({ path: 'proposal.md', content: 'initial', version: 'v1' }); }
    return response(url.endsWith('/workspace') ? { experimentalEnabled: false } : { items: [], errors: [], documentVersions: {} });
  }); vi.stubGlobal('fetch', fetcher);
  await act(async () => { render(<WorkRoom change={{ id: 'demo/feature', sourceId: 'demo', name: 'feature' } as Change} workId="work-1" onClose={() => {}} />); });
  const baseline = fetcher.mock.calls.filter(([url]) => url === '/api/work/work-1').length;
  blockWork = true; blockDoc = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/work/work-1')).toHaveLength(baseline + 1);
  await act(async () => finishWork(response(work)));
  const stream = Stream.all.find(item => item.url.includes('/work/work-1/events'))!;
  await act(async () => { stream.callbacks['work-update']({ data: JSON.stringify({ seq: 1 }) }); await vi.advanceTimersByTimeAsync(6000); });
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/work/work-1')).toHaveLength(baseline + 1);
  blockDoc = false; await act(async () => finishDoc(response({ path: 'proposal.md', content: 'latest', version: 'v2' })));
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/work/work-1')).toHaveLength(baseline + 2);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/document?')).at(-1)?.[0]).toContain('proposal.md');
});
