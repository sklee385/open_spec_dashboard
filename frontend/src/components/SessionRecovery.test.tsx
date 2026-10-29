import { render } from '../test/render';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionRecovery } from './SessionRecovery';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const props = { workId: 'work-1', threadId: 'old-thread', onPreserve: () => true, onRefresh: vi.fn(async () => {}) };

it('초안을 보존할 수 없으면 새 세션 복구 요청을 보내지 않는다', async () => {
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  render(<SessionRecovery {...props} onPreserve={() => false} />);
  fireEvent.click(screen.getByRole('button', { name: '복구용 새 세션으로 이어하기' }));
  expect(request).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toHaveTextContent('초안');
});

it('응답 유실 후 재시도에도 같은 복구 ID를 사용하고 지시를 자동 전송하지 않는다', async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ ok: true, json: async () => ({ sessionRecovery: { status: 'completed', newThreadId: 'new-thread' } }) });
  vi.stubGlobal('fetch', request);
  render(<SessionRecovery {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '복구용 새 세션으로 이어하기' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '복구 요청 다시 확인' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(JSON.parse(request.mock.calls[0][1].body).requestId).toBe(JSON.parse(request.mock.calls[1][1].body).requestId);
  expect(request.mock.calls.every(([path]) => path.endsWith('/recover-session'))).toBe(true);
  expect(await screen.findByText(/자동으로 실행하지 않았습니다/)).toBeVisible();
});

it('이전 실행을 확인하지 못한 복구는 차단 이유를 표시한다', async () => {
  render(<SessionRecovery {...props} recovery={{ requestId: 'r', status: 'blocked', reason: '이전 실행 종료 미확인' }} />);
  expect(screen.getByText('이전 실행 종료 미확인')).toBeVisible();
  expect(screen.getByText(/파일을 변경하지 않습니다/)).toBeVisible();
});

it('한 번 복구한 대화가 다시 잠기면 새 복구 요청을 제공한다', async () => {
  const request = vi.fn(async (_path: string, _options: RequestInit) => ({ ok: true, json: async () => ({ sessionRecovery: { requestId: 'new', status: 'blocked' } }) }));
  vi.stubGlobal('fetch', request);
  render(<SessionRecovery {...props} threadId="new-thread" conflicted recovery={{ requestId: 'previous-request', status: 'completed', previousThreadId: 'old-thread', newThreadId: 'new-thread' }} />);
  fireEvent.click(screen.getByRole('button', { name: '복구용 새 세션으로 이어하기' }));
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(JSON.parse(request.mock.calls[0][1].body as string).requestId).not.toBe('previous-request');
});

it('다른 화면에서 완료된 복구 상태를 받으면 로컬의 오래된 uncertain 표시를 해제한다', async () => {
  const view = render(<SessionRecovery {...props} recovery={{ requestId: 'same', status: 'uncertain' }} />);
  view.rerender(<SessionRecovery {...props} recovery={{ requestId: 'same', status: 'completed', newThreadId: 'new-thread' }} />);
  expect(await screen.findByText(/자동으로 실행하지 않았습니다/)).toBeVisible();
  expect(screen.queryByText(/세션 생성 결과를 확인해야/)).not.toBeInTheDocument();
});

it('명시적으로 실패한 세션 생성은 새 ID로 재시도한다', async () => {
  const request = vi.fn(async (_path: string, _options: RequestInit) => ({ ok: true, json: async () => ({ sessionRecovery: { requestId: 'next', status: 'blocked' } }) }));
  vi.stubGlobal('fetch', request);
  render(<SessionRecovery {...props} recovery={{ requestId: 'failed-request', status: 'failed', previousThreadId: 'old-thread' }} />);
  fireEvent.click(screen.getByRole('button', { name: '새 복구 요청으로 재시도' }));
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(JSON.parse(request.mock.calls[0][1].body as string).requestId).not.toBe('failed-request');
});

it('실패 후 새 요청의 응답까지 유실되면 새로 저장한 ID를 재사용한다', async () => {
  const request = vi.fn().mockRejectedValue(new Error('network'));
  vi.stubGlobal('fetch', request);
  render(<SessionRecovery {...props} onRefresh={async () => { throw Error('offline'); }} recovery={{ requestId: 'failed-request', status: 'failed', previousThreadId: 'old-thread' }} />);
  fireEvent.click(screen.getByRole('button', { name: '새 복구 요청으로 재시도' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '새 복구 요청으로 재시도' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(JSON.parse(request.mock.calls[0][1].body).requestId).toBe(JSON.parse(request.mock.calls[1][1].body).requestId);
});

it('생성 결과가 불명확하면 새 생성 대신 명시적 취소를 요청한다', async () => {
  const request = vi.fn(async (_path: string, _options: RequestInit) => ({ ok: true, json: async () => ({ sessionRecovery: { requestId: 'uncertain-request', status: 'abandoned' } }) }));
  vi.stubGlobal('fetch', request);
  render(<SessionRecovery {...props} recovery={{ requestId: 'uncertain-request', status: 'uncertain' }} />);
  fireEvent.click(screen.getByRole('button', { name: '미확인 복구 취소·상태 재확인' }));
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(request.mock.calls[0][0]).toBe('/api/work/work-1/recover-session/cancel');
  expect(JSON.parse(String(request.mock.calls[0][1].body))).toEqual({ requestId: 'uncertain-request' });
  expect(await screen.findByRole('button', { name: '새 복구 요청으로 재시도' })).toBeEnabled();
});
