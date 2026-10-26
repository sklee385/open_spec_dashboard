import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { SourceManagementModal } from './SourceManagementModal';
import { SettingsModal } from './SettingsModal';
import { createTranslator } from '../i18n/messages';

const original = { name: '원문 source', path: '/original/openspec' };
const added = { name: '새 original', path: '/new/원문' };
const response = (sources = [original]) => ({ ok: true, text: async () => JSON.stringify({ sources }) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fill() {
  fireEvent.change(screen.getByLabelText('이름'), { target: { value: added.name } });
  fireEvent.change(screen.getByLabelText('경로'), { target: { value: added.path } });
}
afterEach(() => { vi.unstubAllGlobals(); });

it('설정에는 AI 도구만 남고 소스를 조회하지 않는다', async () => {
  const fetch = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ defaultToolId: 'codex', tools: [] }) }));
  vi.stubGlobal('fetch', fetch);
  render(<SettingsModal open onOpenChange={() => {}} />);
  await screen.findByRole('button', { name: '외부 도구 추가' });
  expect(screen.queryByLabelText('경로')).not.toBeInTheDocument();
  expect(fetch.mock.calls.some(args => String(args[0]) === '/api/config')).toBe(false);
});

it.each(['ko', 'en'] as const)('%s 독립 창의 제품 문구와 원문을 표시한다', async locale => {
  const t = createTranslator(locale);
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  render(<SourceManagementModal open onOpenChange={() => {}} />, { locale });
  expect(await screen.findByText(original.name)).toBeInTheDocument();
  expect(screen.getByText(original.path)).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: t('sources.title') })).toBeInTheDocument();
  expect(screen.getByLabelText(t('sources.path'))).toBeEnabled();
  expect(screen.queryByText('AI 개발 도구')).not.toBeInTheDocument();
});

it('조회 실패 시 변경을 막고 재시도로 복구한다', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('조회 실패')).mockResolvedValueOnce(response());
  vi.stubGlobal('fetch', fetch);
  render(<SourceManagementModal open onOpenChange={() => {}} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('조회 실패');
  expect(screen.getByLabelText('이름')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(await screen.findByText(original.name)).toBeInTheDocument();
  expect(screen.getByLabelText('이름')).toBeEnabled();
});

it('추가 저장은 한 번만 보내고 서버 반환 목록과 성공을 반영한다', async () => {
  const pending = deferred<ReturnType<typeof response>>();
  const fetch = vi.fn().mockResolvedValueOnce(response()).mockReturnValueOnce(pending.promise);
  const saved = vi.fn(); vi.stubGlobal('fetch', fetch);
  render(<SourceManagementModal open onOpenChange={() => {}} onSaved={saved} />);
  await screen.findByText(original.name); fill();
  const add = screen.getByRole('button', { name: '소스 추가' });
  fireEvent.click(add); fireEvent.click(add);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText('이름')).toBeDisabled();
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ sources: [original, added] });
  await act(async () => pending.resolve(response([original, added])));
  expect(await screen.findByText(added.name)).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('저장했습니다');
  expect(saved).toHaveBeenCalledWith([original, added]);
});

it('서버가 제외한 경로는 추가 성공으로 안내하지 않는다', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response()));
  render(<SourceManagementModal open onOpenChange={() => {}} />);
  await screen.findByText(original.name); fill();
  fireEvent.click(screen.getByRole('button', { name: '소스 추가' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('등록되지 않았습니다');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByLabelText('이름')).toHaveValue(added.name);
});

it('등록 해제는 목록 저장만 요청하고 응답으로 갱신한다', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response([]));
  vi.stubGlobal('fetch', fetch);
  render(<SourceManagementModal open onOpenChange={() => {}} />);
  await screen.findByText(original.name);
  fireEvent.click(screen.getByRole('button', { name: /원문 source.*등록 해제/ }));
  await screen.findByText('등록된 소스가 없습니다');
  expect(fetch.mock.calls[1][0]).toBe('/api/config/sources');
  expect(fetch.mock.calls[1][1].method).toBe('PUT');
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ sources: [] });
});

it.each([false, true])('저장 실패와 복구 조회 실패(%s)를 표시하고 재시도를 허용한다', async recoveryFails => {
  const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('저장 실패'));
  if (recoveryFails) fetch.mockRejectedValueOnce(new Error('복구 조회 실패'));
  else fetch.mockResolvedValueOnce(response());
  vi.stubGlobal('fetch', fetch);
  render(<SourceManagementModal open onOpenChange={() => {}} />);
  await screen.findByText(original.name); fill();
  fireEvent.click(screen.getByRole('button', { name: '소스 추가' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(await screen.findByRole('alert')).toHaveTextContent('저장 실패');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  if (recoveryFails) {
    expect(screen.getByRole('alert')).toHaveTextContent('복구 조회 실패');
    expect(screen.getByLabelText('이름')).toBeDisabled();
    fetch.mockResolvedValueOnce(response());
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  }
  await waitFor(() => expect(screen.getByLabelText('이름')).toBeEnabled());
  expect(screen.getByText(original.name)).toBeInTheDocument();
});

it('다시 연 창에 이전 조회 응답이 늦게 와도 덮어쓰지 않는다', async () => {
  const first = deferred<ReturnType<typeof response>>();
  const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(response([added]));
  vi.stubGlobal('fetch', fetch);
  const { rerender } = render(<SourceManagementModal open onOpenChange={() => {}} />);
  rerender(<SourceManagementModal open={false} onOpenChange={() => {}} />);
  rerender(<SourceManagementModal open onOpenChange={() => {}} />);
  await screen.findByText(added.name);
  await act(async () => first.resolve(response()));
  expect(screen.queryByText(original.name)).not.toBeInTheDocument();
});
