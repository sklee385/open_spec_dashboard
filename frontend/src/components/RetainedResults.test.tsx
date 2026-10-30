import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { RetainedResults } from './RetainedResults';
import { ChangeResults } from './ChangeResults';
const capture = { captureId: 'capture-a', workId: 'real-work', fileCount: 2, verificationCount: 1, integration: { candidateId: 'candidate', targetBranch: 'main', appliedCommit: 'applied-commit', resultCommit: 'result-commit' } };
const file = { ordinal: 0, path: 'a.ts', status: 'modified', beforeAvailability: 'text', afterAvailability: 'text' };
afterEach(() => vi.unstubAllGlobals());
it('uses the retained work identity, pages metadata and fetches a file body only after an explicit open', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET'); const query = new URL(url, 'http://test').searchParams;
    return { ok: true, json: async () => url.includes('/completion/file?') ? { ...file, before: 'before', after: 'after' } : url.includes('/completion/files?') ? { workId: 'real-work', captureId: 'capture-a', files: query.get('after') === '0' ? [file] : [{ ...file, ordinal: 1, path: 'b.ts' }], nextCursor: query.get('after') === '0' ? 1 : null } : { workId: 'real-work', captureId: 'capture-a', results: [], nextCursor: null } };
  }); vi.stubGlobal('fetch', fetcher);
  render(<ChangeResults workId="display-change-name" files={[]} report={{ source: 'completed', workId: 'real-work', retained: capture, application: 'applied' }} />);
  await screen.findByRole('button', { name: '파일 열기 a.ts' }); expect(screen.queryByText('변경된 파일이 없습니다.')).toBeNull(); expect(screen.getByText('applied-commit')).toBeVisible();
  expect(fetcher.mock.calls.every(([url]) => url.startsWith('/api/work/real-work/completion/'))).toBe(true); expect(fetcher.mock.calls.some(([url]) => url.includes('/completion/file?'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '파일 더 보기' })); await screen.findByRole('button', { name: '파일 열기 b.ts' }); expect(fetcher.mock.calls.some(([url]) => url.includes('/files?') && new URL(url, 'http://test').searchParams.get('after') === '1')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '파일 열기 a.ts' })); const diff = await screen.findByRole('region', { name: '수정된 줄' }); expect(diff).toHaveTextContent('before'); expect(diff).toHaveTextContent('after'); expect(fetcher.mock.calls.filter(([url]) => url.includes('/completion/file?'))).toHaveLength(1);
});
it('ignores an old capture reply after navigation and rejects a mismatched page identity', async () => {
  let finishOld!: (value: unknown) => void;
  const fetcher = vi.fn((url: string) => url.includes('capture-a') && url.includes('/files?') ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve({ ok: true, json: async () => url.includes('/files?') ? { workId: 'wrong-work', captureId: 'capture-b', files: [file], nextCursor: null } : { workId: url.includes('capture-a') ? 'real-work' : 'new-work', captureId: url.includes('capture-a') ? 'capture-a' : 'capture-b', results: [], nextCursor: null } })); vi.stubGlobal('fetch', fetcher);
  const first = render(<RetainedResults workId="real-work" capture={capture} />);
  first.rerender(<RetainedResults workId="new-work" capture={{ ...capture, captureId: 'capture-b', workId: 'new-work' }} />);
  await screen.findByText('보존 결과의 업무 또는 캡처가 일치하지 않습니다.');
  await act(async () => finishOld({ ok: true, json: async () => ({ workId: 'real-work', captureId: 'capture-a', files: [{ ...file, path: 'old.ts' }], nextCursor: null }) }));
  expect(screen.queryByRole('button', { name: '파일 열기 old.ts' })).toBeNull(); expect(screen.queryByRole('button', { name: '파일 열기 a.ts' })).toBeNull();
});
it('shows server evidence states without inferring expiry or linking unavailable and external evidence', async () => {
  const results = [
    { ordinal: 0, id: 'available', targetKind: 'integration-candidate', status: 'passed', evidence: { id: 'proof-a', state: 'available', url: '/api/work/real-work/evidence/proof-a', eligibleForCleanup: true } },
    { ordinal: 1, id: 'expired', targetKind: 'work', status: 'passed', evidence: { id: 'proof-b', state: 'expired', url: '/api/not-followed' } },
    { ordinal: 2, id: 'missing', targetKind: 'work', status: 'failed', evidence: { id: 'proof-c', state: 'missing', url: '/api/not-followed' } },
    { ordinal: 3, id: 'external', targetKind: 'work', status: 'passed', evidence: { id: 'proof-d', state: 'available', url: 'https://example.com/evidence.png' } },
  ];
  const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/files?') ? { workId: 'real-work', captureId: 'capture-a', files: [], nextCursor: null } : { workId: 'real-work', captureId: 'capture-a', results, nextCursor: null } })); vi.stubGlobal('fetch', fetcher);
  render(<RetainedResults workId="real-work" capture={capture} />);
  const links = await screen.findAllByRole('link', { name: '검증 자료 열기' }); expect(links).toHaveLength(1); expect(links[0]).toHaveAttribute('href', '/api/work/real-work/evidence/proof-a');
  expect(screen.getByText('정리 대상 · 자동 삭제하지 않음')).toBeVisible(); expect(screen.getByText('보존 기간 만료')).toBeVisible(); expect(screen.getByText('자료 없음')).toBeVisible(); expect(document.querySelector('img')).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('retries a failed page as a read without loading all file bodies', async () => {
  let fail = true; const fetcher = vi.fn(async (url: string, init?: RequestInit) => { expect(init?.method ?? 'GET').toBe('GET'); return { ok: !url.includes('/files?') || !fail, status: 503, json: async () => url.includes('/files?') ? { workId: 'real-work', captureId: 'capture-a', files: [file], nextCursor: null } : { workId: 'real-work', captureId: 'capture-a', results: [], nextCursor: null } }; }); vi.stubGlobal('fetch', fetcher);
  render(<RetainedResults workId="real-work" capture={capture} />); await screen.findByRole('button', { name: '파일 목록 다시 읽기' }); fail = false; fireEvent.click(screen.getByRole('button', { name: '파일 목록 다시 읽기' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '파일 열기 a.ts' })).toBeVisible()); expect(fetcher.mock.calls.some(([url]) => url.includes('/completion/file?'))).toBe(false);
});
