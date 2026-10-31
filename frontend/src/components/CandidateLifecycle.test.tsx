import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { CandidateLifecycle } from './CandidateLifecycle';
const candidate = { id: 'integration', candidateId: 'c', status: 'ready', version: 1, targetBranch: 'main', targetHead: 'target', workHead: 'work', candidateCommit: 'candidate', executionPath: 'C:/owned/c', conflicts: [] };
const verification = { verificationPlan: { scope: 'full', reason: '명시적으로 선택한 전체 계획', choiceVersion: 'choice-version' }, candidateId: 'c', candidateVersion: 'version', executionPath: 'C:/owned/c', commands: [{ id: 'test', command: 'npm', args: ['test'] }], runs: [], cliPassed: true, browserRequired: false, browserStatus: 'not-required', ready: true };
const status = { candidateId: 'c', receipt: null, receipts: [], live: { state: 'settled' }, observation: { state: 'not-checked' } };
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
function api(values: { browser?: boolean; applied?: boolean } = {}) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, json: async () => init?.method === 'POST' ? url.endsWith('/apply') ? { status: 'applied', applied: true, appliedCommit: 'candidate' } : url.endsWith('/cancel') ? { cancelled: true } : { id: 'run', status: 'running', commands: [] } : url.includes('/verification/') ? { ...verification, browserRequired: !!values.browser, ready: !values.browser } : url.endsWith('/apply/preview') ? { expectedVersion: 'expected', preflightPassed: true } : values.applied ? { ...status, receipt: { requestKey: 'old-key', status: 'applied', appliedCommit: 'candidate' }, receipts: [{ requestKey: 'old-key', status: 'applied', appliedCommit: 'candidate' }], observation: { state: 'not-checked', last: { state: 'applied', head: 'candidate' } } } : status })); vi.stubGlobal('fetch', fetcher); return fetcher;
}
it('requires explicit preview and confirmation before applying and never completes the work automatically', async () => {
  const fetcher = api(); render(<CandidateLifecycle workId="w" candidate={candidate} />);
  await screen.findByText('현재 관측'); expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '후보 검증 기준·결과 확인' })); await screen.findByText('CLI 통과');
  fireEvent.click(screen.getByRole('button', { name: '원본 반영 사전 검사' })); await screen.findByText('사전 검사 통과');
  expect(screen.getByRole('button', { name: '원본에 명시적으로 반영' })).toBeDisabled(); fireEvent.click(screen.getByLabelText('표시된 후보와 원본 반영을 확인했습니다')); fireEvent.click(screen.getByRole('button', { name: '원본에 명시적으로 반영' }));
  await waitFor(() => expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1));
  expect(JSON.parse(String(fetcher.mock.calls.find(call => call[1]?.method === 'POST')![1]?.body))).toEqual({ requestKey: expect.any(String), confirmed: true, expectedVersion: 'expected' }); expect(fetcher.mock.calls.some(([url]) => url.includes('/action'))).toBe(false);
});
it('does not equate CLI pass with candidate readiness when browser evidence is required', async () => {
  api({ browser: true }); render(<CandidateLifecycle workId="w" candidate={candidate} />); fireEvent.click(await screen.findByRole('button', { name: '후보 검증 기준·결과 확인' })); await screen.findByText('후보 브라우저 검증 필요'); expect(screen.getByRole('button', { name: '원본 반영 사전 검사' })).toBeDisabled();
});
it('keeps applied history inspectable and sends logical cancellation with the strict body only', async () => {
  const fetcher = api({ applied: true }); render(<CandidateLifecycle workId="w" candidate={{ ...candidate, status: 'applied' }} />); await screen.findByText('old-key'); expect(screen.getByText('과거 관측')).toBeVisible(); expect(screen.getByRole('button', { name: '원본에 명시적으로 반영' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '현재 원본 상태 관측' })); await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith('inspect=1'))).toBe(true));
});
it('blocks verification and application for unsaved work documents without discarding them', async () => {
  const fetcher = api(); render(<CandidateLifecycle workId="w" candidate={candidate} workDirty />); await screen.findByText('현재 관측'); expect(screen.getByRole('button', { name: '후보 CLI 검증 실행' })).toBeDisabled(); expect(screen.getByRole('button', { name: '원본 반영 사전 검사' })).toBeDisabled(); expect(fetcher.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0);
});

it('unblocks reads after a hidden pending verification response finishes', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/verification/results') ? pending : status })));
  const view = render(<CandidateLifecycle workId="w" candidate={candidate} />);
  await screen.findByText('현재 관측');
  fireEvent.click(screen.getByRole('button', { name: '후보 검증 기준·결과 확인' }));
  expect(screen.getByRole('button', { name: '후보 검증 기준·결과 확인' })).toBeDisabled();
  view.rerender(<CandidateLifecycle workId="w" candidate={candidate} active={false} />);
  await act(async () => { finish(verification); await pending; });
  view.rerender(<CandidateLifecycle workId="w" candidate={candidate} active />);
  await waitFor(() => expect(screen.getByRole('button', { name: '후보 검증 기준·결과 확인' })).toBeEnabled());
});
it('keeps malformed status unavailable without crashing or allowing application', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  render(<CandidateLifecycle workId="w" candidate={candidate} />);
  await screen.findByText('후보 상태 응답을 확인하지 못했습니다. 다시 조회해 주세요.');
  expect(screen.getByRole('button', { name: '원본 반영 사전 검사' })).toBeDisabled();
});
it('times out a stalled cheap status read and lets the queued latest read finish', async () => {
  vi.useFakeTimers();
  let firstSignal: AbortSignal | undefined;
  const fetcher = vi.fn().mockImplementationOnce((_url: string, init?: RequestInit) => {
    firstSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => firstSignal?.addEventListener('abort', () => reject(new Error('read timed out'))));
  }).mockResolvedValue({ ok: true, json: async () => status });
  vi.stubGlobal('fetch', fetcher);
  let view: ReturnType<typeof render> | undefined;
  try {
    await act(async () => { view = render(<CandidateLifecycle workId="w" candidate={candidate} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(firstSignal).toMatchObject({ aborted: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url, init]) => url.endsWith('/apply/status') && init?.method !== 'POST')).toBe(true);
  } finally { view?.unmount(); vi.useRealTimers(); }
});
it('ignores a late verification response from an older candidate edit generation', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/verification/results') ? pending : url.includes('/verification/') ? verification : status })));
  const view = render(<CandidateLifecycle workId="w" candidate={candidate} />);
  fireEvent.click(await screen.findByRole('button', { name: '후보 검증 기준·결과 확인' }));
  view.rerender(<CandidateLifecycle workId="w" candidate={{ ...candidate, candidateMutationVersion: 'new-edit' }} />);
  await act(async () => { finish(verification); await pending; });
  expect(screen.queryByText('CLI 통과')).toBeNull();
  expect(screen.getByRole('button', { name: '원본 반영 사전 검사' })).toBeDisabled();
});
it('keeps inspection usable while apply POST hangs and settles only its matching terminated receipt before a late reply', async () => {
  let finish!: (value: unknown) => void, body: Record<string, unknown> | undefined, observed = false;
  const pending = new Promise(resolve => { finish = resolve; });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { body = JSON.parse(String(init.body)); return pending; }
    const receipt = body && observed ? { id: 'apply-run', workId: 'w', candidateId: 'c', requestKey: body.requestKey, expectedVersion: body.expectedVersion, status: 'applied', processTerminated: true, appliedCommit: 'candidate' } : null;
    return { ok: true, json: async () => url.includes('/verification/') ? verification : url.endsWith('/apply/preview') ? { expectedVersion: 'expected' } : { ...status, receipt, receipts: receipt ? [receipt] : [] } };
  });
  vi.stubGlobal('fetch', fetcher); render(<CandidateLifecycle workId="w" candidate={candidate} />);
  fireEvent.click(await screen.findByRole('button', { name: '후보 검증 기준·결과 확인' })); await screen.findByText('CLI 통과');
  fireEvent.click(screen.getByRole('button', { name: '원본 반영 사전 검사' })); await screen.findByText('사전 검사 통과');
  fireEvent.click(screen.getByLabelText('표시된 후보와 원본 반영을 확인했습니다')); fireEvent.click(screen.getByRole('button', { name: '원본에 명시적으로 반영' }));
  await waitFor(() => expect(body?.requestKey).toBeTruthy());
  const inspect = screen.getByRole('button', { name: '현재 원본 상태 관측' }); expect(inspect).toBeEnabled();
  observed = true; fireEvent.click(inspect);
  const saved = () => JSON.parse(localStorage.getItem('integration-control:candidate-apply:w:c') ?? 'null');
  await waitFor(() => expect(saved()?.state).toBe('completed'));
  const observationAttempt = saved().attemptId;
  await act(async () => { finish({ ok: true, json: async () => ({ status: 'running', requestKey: body!.requestKey }) }); await pending; });
  expect(saved()).toMatchObject({ state: 'completed', attemptId: observationAttempt });
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('does not let an older POST finally release the busy state of a newer attempt', async () => {
  const replies: ((value: unknown) => void)[] = [], bodies: Record<string, unknown>[] = []; let observed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { bodies.push(JSON.parse(String(init.body))); return new Promise(resolve => { replies.push(resolve); }); }
    const body = bodies[0], receipt = body && observed ? { workId: 'w', candidateId: 'c', requestKey: body.requestKey, expectedVersion: body.expectedVersion, status: 'failed', processTerminated: true } : null;
    return { ok: true, json: async () => url.includes('/verification/') ? verification : url.endsWith('/apply/preview') ? { expectedVersion: 'expected' } : { ...status, receipt, receipts: receipt ? [receipt] : [] } };
  }));
  render(<CandidateLifecycle workId="w" candidate={candidate} />);
  fireEvent.click(await screen.findByRole('button', { name: '후보 검증 기준·결과 확인' })); await screen.findByText('CLI 통과');
  fireEvent.click(screen.getByRole('button', { name: '원본 반영 사전 검사' })); await screen.findByText('사전 검사 통과');
  fireEvent.click(screen.getByLabelText('표시된 후보와 원본 반영을 확인했습니다')); fireEvent.click(screen.getByRole('button', { name: '원본에 명시적으로 반영' }));
  await waitFor(() => expect(replies).toHaveLength(1)); observed = true; fireEvent.click(screen.getByRole('button', { name: '현재 원본 상태 관측' }));
  const saved = () => JSON.parse(localStorage.getItem('integration-control:candidate-apply:w:c') ?? 'null');
  await waitFor(() => expect(saved()?.state).toBe('failed'));
  fireEvent.click(screen.getByRole('button', { name: '원본에 명시적으로 반영' })); await waitFor(() => expect(replies).toHaveLength(2));
  const newer = saved(); await act(async () => { replies[0]({ ok: true, json: async () => ({ status: 'running' }) }); });
  expect(saved()).toEqual(newer); expect(screen.getByRole('button', { name: '원본에 명시적으로 반영' })).toBeDisabled();
  await act(async () => { replies[1]({ ok: true, json: async () => ({ status: 'failed' }) }); });
});
it('keeps a running verification readable without requesting a conflicting new preview', async () => {
  const fetcher = vi.fn(async (url: string) => ({ok:!url.endsWith('/verification/preview'),status:url.endsWith('/verification/preview')?409:200,json:async()=>url.endsWith('/verification/results')?{...verification,ready:false,cliPassed:false,runs:[{id:'owned-run',status:'running',processTerminated:false,fresh:false}]}:url.endsWith('/verification/preview')?{message:'영향 공간의 Git 프로세스 또는 결과가 미확인입니다'}:status}));
  vi.stubGlobal('fetch',fetcher);render(<CandidateLifecycle workId="w" candidate={{...candidate,status:'validating'}} />);
  fireEvent.click(await screen.findByRole('button',{name:'후보 검증 기준·결과 확인'}));
  await screen.findByText(/owned-run/);
  await waitFor(()=>expect(screen.getByRole('button',{name:'후보 검증 기준·결과 확인'})).toBeEnabled());
  expect(fetcher.mock.calls.some(([url])=>url.endsWith('/verification/preview'))).toBe(false);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'원본에 명시적으로 반영'})).toBeDisabled();
});

it('후보의 검사 범위를 현재 선택 기준으로만 변경하고 재확인한다', async () => {
  const fetcher = api(); render(<CandidateLifecycle workId="w" candidate={candidate} />);
  await screen.findByText('현재 관측');
  fireEvent.click(screen.getByRole('button', { name: '후보 검증 기준·결과 확인' }));
  await screen.findByText('명시적으로 선택한 전체 계획');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'work' } });
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => url.endsWith('/verification/plan') && init?.method === 'POST')).toBe(true));
  const call = fetcher.mock.calls.find(([url, init]) => url.endsWith('/verification/plan') && init?.method === 'POST')!;
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({ confirmed: true, scope: 'work', choiceVersion: 'choice-version' });
});
