import { render } from '../test/render';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteBoardConnection } from './RemoteBoardConnection';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('연결 안내를 열 때만 조회하고 모바일 미검증 여부와 로컬 명령을 표시한다', async () => {
  const request = vi.fn(async () => ({ ok: true, json: async () => ({ available: true, transport: 'loopback', connectionPath: 'C:\\profile\\board.json', cliPath: 'C:\\app\\board-remote.cjs', nodePath: 'C:\\app\\node.exe', mobileVerified: false }) }));
  vi.stubGlobal('fetch', request);
  render(<RemoteBoardConnection workId="work-1" />);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('모바일 Codex 연결'));
  expect(await screen.findByText(/모바일 실제 연결은 아직 검증하지 않았습니다/)).toBeVisible();
  expect((screen.getByRole('textbox', { name: 'Codex에 전달할 연결 안내' }) as HTMLTextAreaElement).value).toContain("status 'work-1'");
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]).toEqual(['/api/remote']);
});

it('서버가 연결 정보를 제공하지 않으면 사용 가능하다고 표시하지 않는다', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  render(<RemoteBoardConnection workId="work-1" />);
  fireEvent.click(screen.getByText('모바일 Codex 연결'));
  expect(await screen.findByRole('alert')).toHaveTextContent('연결 정보를 확인하지 못했습니다');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
