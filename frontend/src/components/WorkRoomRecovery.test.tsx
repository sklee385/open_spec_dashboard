import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { WorkRoom } from './WorkRoom';
import type { Change } from '../types';
const change = { id: 'demo/recovery', name: 'recovery', sourceId: 'demo' } as Change;
const work = { id: 'recover-work', changeName: 'recovery', phase: 'planning', state: 'idle', threadId: 'same-thread', reviewedVersion: null, documents: ['proposal.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] };
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('긴 만료 질문의 하단 버튼으로 기존 질문 답변을 복구한다', async () => {
  const question = { id: 'expired-question', kind: 'input', status: 'expired', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'channel', question: '알림 방식을 선택하세요', options: [{ label: '화면 알림', description: '긴 설명 '.repeat(100) }] }] } };
  const mock = vi.fn(async (url: string, _options?: RequestInit) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, questions: [question] } }));
  vi.stubGlobal('fetch', mock);
  render(<WorkRoom change={change} onClose={() => {}} />);
  const answer = await screen.findByRole('textbox', { name: '알림 방식을 선택하세요' });
  fireEvent.change(answer, { target: { value: '화면 알림' } });
  const card = answer.closest('.work-question')!;
  const submit = card.querySelector<HTMLButtonElement>('.work-question-actions button')!;
  expect(card.querySelector('.work-question-body')!.contains(submit)).toBe(false);
  fireEvent.click(submit);
  await waitFor(() => expect(mock.mock.calls.some(([url, options]) => url.endsWith('/answer') && JSON.stringify(JSON.parse(String(options?.body))) === JSON.stringify({ questionId: 'expired-question', recover: true, answers: { channel: { answers: ['화면 알림'] } } }))).toBe(true));
});

it('새로고침 후 작성 중인 대화와 질문 답변을 복원한다', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, questions: [{ id: 'question-1', kind: 'input', status: 'pending', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', question: '어떤 방식인가요?' }] } }] } })));
  const first = render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '어떤 방식인가요?' });
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: '아직 보내지 않은 지시' } });
  fireEvent.change(screen.getByRole('textbox', { name: '어떤 방식인가요?' }), { target: { value: '작성 중인 결정' } });
  first.unmount();
  render(<WorkRoom change={change} onClose={() => {}} />);
  expect(await screen.findByRole('textbox', { name: '어떤 방식인가요?' })).toHaveValue('작성 중인 결정');
  expect(screen.getByRole('textbox', { name: 'AI와 문답' })).toHaveValue('아직 보내지 않은 지시');
});
it('세션 서버 재시작은 같은 대화로 자동 연결하되 AI 메시지를 재전송하지 않는다', async () => {
  let connected = false;
  const mock = vi.fn(async (url: string) => {
    if (url.endsWith('/reconnect')) connected = true;
    return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, state: connected ? 'idle' : 'recovery-required', errorCode: connected ? undefined : 'session-restarted' } };
  });
  vi.stubGlobal('fetch', mock); render(<WorkRoom change={change} onClose={() => {}} />);
  await waitFor(() => expect(mock.mock.calls.filter(([url]) => url.endsWith('/reconnect'))).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole('button', { name: '같은 대화 다시 연결' })).not.toBeInTheDocument());
  expect(mock.mock.calls.some(([url]) => url.endsWith('/message'))).toBe(false);
});
it('서버 재시작 중 처음 열었어도 연결 복구 후 같은 업무를 다시 불러온다', async () => {
  let attempts = 0;
  const mock = vi.fn(async (url: string) => {
    if (url === '/api/work' && ++attempts === 1) return { ok: false, status: 503, json: async () => ({ message: '잠시 재시작 중' }) };
    return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '연결 복구 문서', version: 'v1' } : work };
  });
  vi.stubGlobal('fetch', mock); render(<WorkRoom change={change} onClose={() => {}} />);
  expect(await screen.findByRole('textbox', { name: '문서 내용' }, { timeout: 3000 })).toHaveValue('연결 복구 문서');
  expect(attempts).toBe(2); expect(mock.mock.calls.some(([url]) => url.endsWith('/message'))).toBe(false);
});
