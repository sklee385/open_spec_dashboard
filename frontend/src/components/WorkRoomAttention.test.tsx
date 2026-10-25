import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { render } from '../test/render';
import { WorkRoom } from './WorkRoom';
import type { Change } from '../types';
import type { WorkRoomNavigation } from '../lib/attentionNavigation';
const change = { id: 'demo/feature', name: 'feature', sourceId: 'demo' } as Change;
const target = { workId: 'w', questionId: 'q2', token: 1 };
const question = (id: string, status = 'pending') => ({ id, status, kind: 'input', method: 'ask_user', params: { questions: [{ id: 'choice', question: `질문 ${id}` }] } });
const work = { id: 'w', sourceId: 'demo', changeName: 'feature', phase: 'planning', state: 'recovery-required', threadId: 'thread', errorCode: 'session-restarted', reviewedVersion: 'v', documents: ['proposal.md'], events: [{ seq: 1, type: 'user-message', data: { text: '대화' } }], questions: [question('q1'), question('q2')], verifications: [], verificationCommands: [], changes: [] };
function mockWork(questions = work.questions) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => ({ ok: true, json: async () => url.includes('/review-items') ? { items: [], errors: [], documentVersions: {} } : url.includes('/document') ? { path: 'proposal.md', content: '원본', version: 'v1' } : { ...work, questions } }));
  vi.stubGlobal('fetch', fetchMock); return fetchMock;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
it('알림은 기존 업무를 조회하여 대화 탭의 정확한 질문에 이동하고 자동 복구·생성·승인하지 않는다', async () => {
  const fetchMock = mockWork(); localStorage.setItem('work-view:demo/feature', JSON.stringify({ pane: 'output', tab: 'documents' }));
  const scroll = vi.fn(); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  const view = render(<WorkRoom change={change} onClose={() => {}} attentionTarget={target} />);
  await screen.findByRole('textbox', { name: '질문 q2' });
  const q2 = screen.getByRole('textbox', { name: '질문 q2' }).closest('.work-question')!;
  await waitFor(() => expect(q2).toHaveFocus()); expect(scroll).toHaveBeenCalled();
  expect(view.container.querySelector('.pane-chat')).toBeInTheDocument();
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  view.rerender(<WorkRoom change={change} onClose={() => {}} attentionTarget={{ ...target, questionId: 'q1', token: 2 }} />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: '질문 q1' }).closest('.work-question')).toHaveFocus());
});
it('만료 질문 알림은 상태·복구 동작을 보이되 자동 전송하지 않는다', async () => {
  const fetchMock = mockWork([question('q2', 'expired')]);
  render(<WorkRoom change={change} onClose={() => {}} attentionTarget={target} />);
  expect(await screen.findByText('이미 처리되었거나 만료된 요청입니다. 필요하면 기존 질문 복구 동작을 사용해 주세요.')).toBeVisible();
  expect(screen.getByRole('button', { name: '같은 대화로 답변 복구' })).toBeVisible();
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});
it('이동 전 문서·메시지·답변 초안을 보존하고 저장 실패에는 이동을 거부한다', async () => {
  mockWork(); const navigation = createRef<WorkRoomNavigation>();
  render(<WorkRoom change={change} onClose={() => {}} attentionTarget={target} navigationRef={navigation} />);
  await screen.findByRole('textbox', { name: '질문 q2' });
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: '메시지 초안' } });
  fireEvent.change(screen.getByRole('textbox', { name: '질문 q2' }), { target: { value: '답변 초안' } });
  fireEvent.change(await screen.findByRole('textbox', { name: '문서 내용' }), { target: { value: '문서 초안' } });
  let preserved = false; act(() => { preserved = navigation.current!.preserveDrafts(); }); expect(preserved).toBe(true);
  expect(JSON.parse(localStorage.getItem('work-chat-draft:demo/feature')!)).toEqual({ message: '메시지 초안', answers: { 'q2:choice': '답변 초안' } });
  expect(JSON.parse(localStorage.getItem('work-draft:w:proposal.md')!)).toEqual({ content: '문서 초안', version: 'v1' });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  act(() => { preserved = navigation.current!.preserveDrafts(); }); expect(preserved).toBe(false);
  expect(screen.getByRole('textbox', { name: 'AI와 문답' })).toHaveValue('메시지 초안');
});
it('현재 업무에 새 질문 알림이 오면 최신 상세를 확인한 뒤 목표 포커스를 적용한다', async () => {
  let questions = [question('q1')];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/review-items') ? { items: [], errors: [], documentVersions: {} } : url.includes('/document') ? { path: 'proposal.md', content: '원본', version: 'v1' } : { ...work, errorCode: undefined, state: 'idle', questions } })));
  const view = render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '질문 q1' });
  questions = [question('q1'), question('q2')];
  view.rerender(<WorkRoom change={change} onClose={() => {}} attentionTarget={target} />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: '질문 q2' }).closest('.work-question')).toHaveFocus());
  expect(screen.queryByText(/이미 처리되었거나 만료된 요청입니다/)).not.toBeInTheDocument();
});
