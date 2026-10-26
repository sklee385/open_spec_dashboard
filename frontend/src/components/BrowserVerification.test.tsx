import { fireEvent, screen, waitFor } from '@testing-library/react';
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
