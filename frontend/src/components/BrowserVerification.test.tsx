import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { BrowserVerification } from './BrowserVerification';
afterEach(() => vi.unstubAllGlobals());
it('사용자 시나리오 저장과 실행을 제공하고 미실행을 통과로 표시하지 않는다', async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => ({ ok: true, json: async () => init?.method === 'POST' ? { id: 'run', status: 'running' } : { scenario: null, running: false, busy: false, results: [] } }));
  vi.stubGlobal('fetch', fetch); render(<BrowserVerification workId="one" phase="implementation" state="idle" />);
  fireEvent.click(screen.getByText('백그라운드 브라우저 검증'));
  expect(await screen.findByText('아직 실행하지 않았습니다')).toBeVisible();
  expect(screen.getByRole('button', { name: '시나리오 실행' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '시나리오 저장' }));
  await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
  expect((screen.getByLabelText('시나리오 JSON') as HTMLTextAreaElement).value).toContain('14321');
});
it('오래된 통과와 실패 증거를 표시하고 실행 중 중단할 수 있다', async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ scenario: { name: '저장' }, running: true, busy: true, results: [{ id: 'old', status: 'passed', fresh: false, steps: [], image: 'data:image/jpeg;base64,YQ==' }] }) }));
  vi.stubGlobal('fetch', fetch); render(<BrowserVerification workId="two" phase="verification" state="running" />);
  fireEvent.click(screen.getByText('백그라운드 브라우저 검증'));
  expect(await screen.findByText(/다시 검증 필요/)).toBeVisible();
  expect(screen.getByRole('img', { name: '검증 화면' })).toHaveAttribute('src', 'data:image/jpeg;base64,YQ==');
  fireEvent.click(screen.getByRole('button', { name: '브라우저 검증 중단' }));
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(true));
});

it('cheap 조회는 최신성 미확인과 실제 환경·빌드를 표시하고 명시 검사만 현재 통과를 확인한다', async () => {
  const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ scenario: { name: '저장' }, running: false, busy: false, observation: { state: url.includes('inspect=1') ? 'fresh' : 'not-checked' }, results: [{ id: 'proof', status: 'passed', fresh: url.includes('inspect=1'), freshnessState: url.includes('inspect=1') ? 'fresh' : 'not-checked', targetKind: 'work', environmentId: 'environment-proof', environment: { commit: 'executed-commit', build: { state: 'unprepared' } }, buildAttestation: { buildId: 'actual-build-proof' } }] }) }));
  vi.stubGlobal('fetch', fetcher); render(<BrowserVerification workId="proof" phase="verification" state="idle" />); fireEvent.click(screen.getByText('백그라운드 브라우저 검증'));
  expect(await screen.findByText(/최신성 미확인/)).toBeVisible(); expect(screen.queryByText(/다시 검증 필요/)).toBeNull();
  expect(screen.getByText('environment-proof')).toBeInTheDocument(); expect(screen.getByText('actual-build-proof')).toBeInTheDocument(); expect(screen.getByText('executed-commit')).toBeInTheDocument();
  expect(fetcher.mock.calls.every(([url]) => !url.includes('inspect=1'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '검증 결과 최신성 확인' })); await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith('?inspect=1'))).toBe(true));
  expect(await screen.findByText(/현재 기준과 일치/)).toBeVisible();
});
it('브라우저 실행 POST가 대기해도 결과 조회는 계속 사용할 수 있다', async () => {
  let reply!: (value: unknown) => void;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? new Promise(resolve => { reply = resolve; }) : { ok: true, json: async () => ({ scenario: { name: '등록됨' }, running: false, busy: false, results: [] }) });
  vi.stubGlobal('fetch', fetcher); render(<BrowserVerification workId="pending" phase="verification" state="idle" />); fireEvent.click(screen.getByText('백그라운드 브라우저 검증')); await screen.findByText('아직 실행하지 않았습니다');
  fireEvent.click(screen.getByRole('button', { name: '시나리오 실행' })); await waitFor(() => expect(reply).toBeTypeOf('function'));
  const refresh = screen.getByRole('button', { name: '결과 새로고침' }); expect(refresh).toBeEnabled(); const previous = fetcher.mock.calls.length; fireEvent.click(refresh); await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(previous));
  await act(async () => { reply({ ok: true, json: async () => ({ id: 'run', status: 'running' }) }); });
});