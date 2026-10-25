import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { ReviewItems } from './ReviewItems';
import { useReviewItems, type ReviewResponse } from '../hooks/useReviewItems';
import { useSSE } from '../hooks/useApi';

const item = { id: '1', path: 'proposal.md', startLine: 3, endLine: 4, kind: 'confirm' as const, text: '공개 범위 확인', version: 'v1' };
const data: ReviewResponse = { items: [item, { ...item, id: '2', path: 'design.md', kind: 'decision', text: '기간 결정' }], documentVersions: { 'proposal.md': 'v1' }, errors: [] };
function View({ endpoint = '/api/review' }: { endpoint?: string }) {
  const review = useReviewItems(endpoint);
  return <ReviewItems {...review} onSelect={() => {}} />;
}
afterEach(() => vi.unstubAllGlobals());
it('보드와 검토 목록이 기존 파일 변경 연결을 공유한다', async () => {
  const opened = vi.fn();
  class Stream { constructor() { opened(); } addEventListener() {} close() {} }
  vi.stubGlobal('EventSource', Stream);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }));
  function Board() { useSSE(() => {}); return <View />; }
  render(<Board />); await screen.findByText('공개 범위 확인');
  expect(opened).toHaveBeenCalledTimes(1);
});
it('로딩·문서 그룹·종류·원문 이동을 표시한다', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { finish = resolve; })));
  render(<View />);
  expect(screen.getByRole('status')).toHaveTextContent('불러오는 중');
  await act(async () => finish({ ok: true, json: async () => data }));
  expect(screen.getByRole('heading', { name: 'proposal.md' })).toBeVisible();
  expect(screen.getByText('미결정')).toBeVisible();
  expect(screen.getByRole('button', { name: /공개 범위 확인/ })).toBeVisible();
});
it('배경 갱신 중에도 원문 선택을 유지하고 이동 요청에서 최신 버전을 확인한다', () => {
  const select = vi.fn();
  render(<ReviewItems data={data} loading error={false} refresh={async () => data} onSelect={select} />);
  const button = screen.getByRole('button', { name: /공개 범위 확인/ });
  expect(button).toBeEnabled(); fireEvent.click(button); expect(select).toHaveBeenCalledWith(item);
});
it('부분 오류를 빈 목록과 구분하고 재시도한다', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ...data, items: [], errors: [{ path: 'design.md', code: 'EACCES', message: '실패' }] }) }).mockResolvedValue({ ok: true, json: async () => ({ ...data, items: [] }) });
  vi.stubGlobal('fetch', fetch); render(<View />);
  expect(await screen.findByRole('alert')).toHaveTextContent('design.md');
  expect(screen.queryByText('검토 항목이 없습니다.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(await screen.findByText('검토 항목이 없습니다.')).toBeVisible();
  expect(screen.getByText(/review:confirm/)).toBeVisible();
});
it('SSE 변경의 추가·수정·삭제를 반영하고 실패 후 오래된 목록을 구분한다', async () => {
  class Stream { static current: Stream; callbacks: Record<string, () => void> = {}; onopen?: () => void; close() {} addEventListener(name: string, cb: () => void) { this.callbacks[name] = cb; } constructor() { Stream.current = this; } }
  vi.stubGlobal('EventSource', Stream);
  let result = data;
  const fetch = vi.fn(async () => ({ ok: true, json: async () => result })); vi.stubGlobal('fetch', fetch);
  render(<View />); await screen.findByText('공개 범위 확인');
  result = { ...data, items: [{ ...item, text: '새 항목' }] };
  act(() => Stream.current.callbacks.update()); await screen.findByText('새 항목');
  expect(screen.queryByText('기간 결정')).not.toBeInTheDocument();
  fetch.mockRejectedValueOnce(new Error('offline'));
  act(() => Stream.current.callbacks.update());
  expect(await screen.findByRole('alert')).toHaveTextContent('최신');
  result = { ...data, items: [] };
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByText('검토 항목이 없습니다.');
});
it('변경을 바꾼 뒤 도착한 이전 응답을 무시한다', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ok: true, json: async () => ({ ...data, items: [{ ...item, text: '새 업무' }] }) }));
  const view = render(<View />); view.rerender(<View endpoint="/api/other" />);
  await screen.findByText('새 업무');
  await act(async () => finish({ ok: true, json: async () => data }));
  await waitFor(() => expect(screen.queryByText('공개 범위 확인')).not.toBeInTheDocument());
});
it('같은 업무에서도 최신 요청보다 늦게 도착한 응답을 무시한다', async () => {
  class Stream { static current: Stream; callbacks: Record<string, () => void> = {}; close() {} addEventListener(name: string, cb: () => void) { this.callbacks[name] = cb; } constructor() { Stream.current = this; } }
  vi.stubGlobal('EventSource', Stream);
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ok: true, json: async () => ({ ...data, items: [{ ...item, text: '최신 요청' }] }) }));
  render(<View />);
  act(() => Stream.current.callbacks.update()); await screen.findByText('최신 요청');
  await act(async () => finish({ ok: true, json: async () => data }));
  expect(screen.queryByText('공개 범위 확인')).not.toBeInTheDocument();
});
