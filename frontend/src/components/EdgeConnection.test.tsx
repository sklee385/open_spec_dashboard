import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { EdgeConnection } from './EdgeConnection';
afterEach(() => vi.unstubAllGlobals());
function setup(supported = true) {
  let connected = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, json: async () => {
    if (url.endsWith('/status')) return { extensionPath: 'D:/test/edge-extension', connections: [] };
    if (init?.method === 'DELETE') { connected = false; return { connected }; }
    if (url.endsWith('/pair')) return { endpoint: 'http://127.0.0.1:15000', code: 'pair-code', expiresAt: new Date(Date.now() + 120000).toISOString() };
    return { supported, connected, ...(connected ? { title: 'Dashboard', url: 'http://localhost:13001/' } : {}) };
  } }));
  vi.stubGlobal('fetch', fetch); return { fetch, connect: () => { connected = true; } };
}
it('설정은 펼칠 때 설치 안내를 불러오고 연결 코드는 업무에서만 발급한다', async () => {
  const { fetch } = setup(); render(<EdgeConnection />);
  expect(fetch).not.toHaveBeenCalled(); fireEvent.click(screen.getByText('Edge 연결'));
  expect(await screen.findByText('D:/test/edge-extension')).toBeVisible();
  expect(screen.queryByRole('button', { name: '연결 코드 만들기' })).not.toBeInTheDocument();
});
it('새 업무에서 코드 발급과 실제 연결 확인 및 해제를 제공한다', async () => {
  const { fetch, connect } = setup(); render(<EdgeConnection workId="new" />);
  fireEvent.click(screen.getByText('Edge 연결'));
  fireEvent.click(await screen.findByRole('button', { name: '연결 코드 만들기' }));
  expect(await screen.findByText('pair-code')).toBeVisible(); expect(screen.getByText('http://127.0.0.1:15000')).toBeVisible();
  expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  connect(); fireEvent.click(screen.getByRole('button', { name: '연결 상태 확인' }));
  expect(await screen.findByText('Dashboard')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Edge 연결 해제' }));
  await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true));
  await waitFor(() => expect(screen.queryByText('Dashboard')).not.toBeInTheDocument());
});
it('기존 대화에는 제한 안내를 표시하고 코드를 발급하지 않는다', async () => {
  setup(false); render(<EdgeConnection workId="old" />); fireEvent.click(screen.getByText('Edge 연결'));
  expect(await screen.findByText(/이 대화에는 Edge 도구가 없습니다/)).toBeVisible();
  expect(screen.queryByRole('button', { name: '연결 코드 만들기' })).not.toBeInTheDocument();
});
it('불완전한 응답을 연결 성공으로 표시하지 않는다', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ message: '서비스 연결 실패' }) })));
  render(<EdgeConnection workId="new" />); fireEvent.click(screen.getByText('Edge 연결'));
  expect(await screen.findByRole('alert')).toHaveTextContent('서비스 연결 실패');
});
