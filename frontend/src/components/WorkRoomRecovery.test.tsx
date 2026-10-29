import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { WorkRoom } from './WorkRoom';
import type { Change } from '../types';
const change = { id: 'demo/recovery', name: 'recovery', sourceId: 'demo' } as Change;
const work = { id: 'recover-work', changeName: 'recovery', phase: 'planning', state: 'idle', threadId: 'same-thread', reviewedVersion: null, documents: ['proposal.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); delete window.desktopDrafts; });
it.each(['message', 'answer'] as const)('keeps a newer %s pending when profile persistence fails as an earlier send completes', async kind => {
  const data = new Map<string, string>(); let fail = false, sent: (() => void) | undefined;
  window.desktopDrafts = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { if (fail) throw new Error('disk full'); data.set(key, value); }, removeItem: key => { data.delete(key); } };
  const questions = [{ id: 'q', kind: 'input', status: 'pending', method: 'ask_user', params: { questions: [{ id: 'choice', question: '진행 중 답변' }] } }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith(`/${kind}`)) await new Promise<void>(resolve => { sent = resolve; });
    return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: 'original', version: 'v1' } : { ...work, questions } };
  }));
  const close = vi.fn(); render(<WorkRoom change={change} onClose={close} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  const input = screen.getByRole('textbox', { name: kind === 'message' ? 'AI와 문답' : '진행 중 답변' });
  const sendName = kind === 'message' ? '보내기' : '답변 전달';
  fireEvent.change(input, { target: { value: 'first snapshot' } });
  fireEvent.click(screen.getByRole('button', { name: sendName }));
  fireEvent.change(input, { target: { value: 'newer pending draft' } });
  fail = true; sent?.();
  await waitFor(() => expect(screen.getByRole('button', { name: sendName })).not.toBeDisabled());
  expect(await screen.findByText('로컬 초안을 저장하지 못했습니다. 이 화면을 유지하고 저장 공간과 권한을 확인해 주세요.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '← 보드로 돌아가기' }));
  expect(close).not.toHaveBeenCalled(); expect(input).toHaveValue('newer pending draft');
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '← 보드로 돌아가기' }));
  expect(close).toHaveBeenCalledOnce();
  const stored = JSON.parse(data.get(`work-chat-draft:${change.id}`)!);
  expect(kind === 'message' ? stored.message : stored.answers['q:choice']).toBe('newer pending draft');
});
it('retains a clean document screen when normal close cannot flush a message draft', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: 'original', version: 'v1' } : work })));
  const close = vi.fn(); render(<WorkRoom change={change} onClose={close} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: 'must preserve this message' } });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  fireEvent.click(screen.getByRole('button', { name: '← 보드로 돌아가기' }));
  expect(close).not.toHaveBeenCalled();
  expect(await screen.findByText('로컬 초안을 저장하지 못했습니다. 이 화면을 유지하고 저장 공간과 권한을 확인해 주세요.')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'AI와 문답' })).toHaveValue('must preserve this message');
});
it('restores work chat, answers and documents from the profile bridge after origin storage is replaced', async () => {
  const data = new Map<string, string>();
  window.desktopDrafts = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
  const questions = [{ id: 'q', kind: 'input', status: 'pending', method: 'ask_user', params: { questions: [{ id: 'choice', question: '복원할 답변' }] } }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: 'original', version: 'v1' } : { ...work, questions } })));
  const first = render(<WorkRoom change={change} onClose={() => {}} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '문서 내용' }), { target: { value: 'profile document' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: 'profile message' } });
  fireEvent.change(screen.getByRole('textbox', { name: '복원할 답변' }), { target: { value: 'profile answer' } });
  first.unmount(); localStorage.clear();
  render(<WorkRoom change={change} onClose={() => {}} />);
  expect(await screen.findByRole('textbox', { name: '문서 내용' })).toHaveValue('profile document');
  expect(screen.getByRole('textbox', { name: 'AI와 문답' })).toHaveValue('profile message');
  expect(screen.getByRole('textbox', { name: '복원할 답변' })).toHaveValue('profile answer');
  expect(data.has(`work-view:${change.id}`)).toBe(true);
});
it('restores document drafts with an explicit server conflict before saving', async () => {
  localStorage.setItem(`work-draft:${work.id}:proposal.md`, JSON.stringify({ content: 'local draft', version: 'v1' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: 'server changed', version: 'v2' } : work })));
  render(<WorkRoom change={change} onClose={() => {}} />);
  expect(await screen.findByRole('textbox', { name: '문서 내용' })).toHaveValue('local draft');
  expect(screen.getByRole('region', { name: '문서 충돌 해결' })).toHaveTextContent('server changed');
  expect(screen.getByText('로컬 초안을 복원했습니다. 원본은 저장할 때까지 변경되지 않습니다.')).toBeInTheDocument();
});

it('removes only a successfully sent message draft and never resurrects it on unload', async () => {
  localStorage.setItem(`work-chat-draft:${change.id}`, JSON.stringify({ message: 'send me', answers: {} }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: 'original', version: 'v1' } : work })));
  render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.click(screen.getByRole('button', { name: '보내기' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'AI와 문답' })).toHaveValue(''));
  fireEvent(window, new Event('beforeunload'));
  expect(localStorage.getItem(`work-chat-draft:${change.id}`)).toBeNull();
});

it('keeps message drafts isolated when the same component changes work', async () => {
  const mock = vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: 'original', version: 'v1' } : { ...work, id: init?.body && JSON.parse(String(init.body)).changeName === 'second' ? 'second-work' : work.id } }));
  vi.stubGlobal('fetch', mock);
  const first = render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: 'first draft' } });
  const second = { ...change, id: 'demo/second', name: 'second' };
  first.rerender(<WorkRoom change={second} onClose={() => {}} />);
  expect(screen.getByRole('textbox', { name: 'AI와 문답' })).toHaveValue('');
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: 'second draft' } });
  fireEvent(window, new Event('beforeunload'));
  expect(JSON.parse(localStorage.getItem(`work-chat-draft:${change.id}`)!)).toMatchObject({ message: 'first draft' });
  expect(JSON.parse(localStorage.getItem(`work-chat-draft:${second.id}`)!)).toMatchObject({ message: 'second draft' });
});

it('does not resurrect an older persisted document edit after the user reverts its content', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: 'original', version: 'v1' } : work })));
  const view = render(<WorkRoom change={change} onClose={() => {}} />);
  const content = await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.change(content, { target: { value: 'older edit' } });
  fireEvent(window, new Event('beforeunload'));
  fireEvent.change(content, { target: { value: 'original' } });
  fireEvent(window, new Event('beforeunload'));
  view.unmount();
  render(<WorkRoom change={change} onClose={() => {}} />);
  expect(await screen.findByRole('textbox', { name: '문서 내용' })).toHaveValue('original');
});

it('preserves newer message input typed while an earlier message is being sent', async () => {
  let sent: (() => void) | undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/message')) await new Promise<void>(resolve => { sent = resolve; });
    return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: 'original', version: 'v1' } : work };
  }));
  render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  const input = screen.getByRole('textbox', { name: 'AI와 문답' });
  fireEvent.change(input, { target: { value: 'first message' } });
  fireEvent.click(screen.getByRole('button', { name: '보내기' }));
  fireEvent.change(input, { target: { value: 'next message draft' } });
  sent?.();
  await waitFor(() => expect(screen.getByRole('button', { name: '보내기' })).not.toBeDisabled());
  expect(input).toHaveValue('next message draft');
});
it('keeps newer structured answer edits while clearing only the submitted answer snapshot', async () => {
  let sent: (() => void) | undefined;
  const questions = [{ id: 'q', kind: 'input', status: 'pending', method: 'ask_user', params: { questions: [{ id: 'choice', question: '결정 입력' }] } }];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/answer')) await new Promise<void>(resolve => { sent = resolve; });
    return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: 'original', version: 'v1' } : { ...work, questions } };
  }));
  render(<WorkRoom change={change} onClose={() => {}} />);
  const input = await screen.findByRole('textbox', { name: '결정 입력' });
  fireEvent.change(input, { target: { value: 'first answer' } });
  fireEvent.click(screen.getByRole('button', { name: '답변 전달' }));
  fireEvent.change(input, { target: { value: 'new answer draft' } });
  sent?.();
  await waitFor(() => expect(screen.getByRole('button', { name: '답변 전달' })).not.toBeDisabled());
  expect(input).toHaveValue('new answer draft');
});

it('flushes message input on unload and reports local storage failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: 'original', version: 'v1' } : work })));
  render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: 'unsaved' } });
  fireEvent(window, new Event('beforeunload'));
  expect(await screen.findByText('로컬 초안을 저장하지 못했습니다. 이 화면을 유지하고 저장 공간과 권한을 확인해 주세요.')).toBeInTheDocument();
  spy.mockRestore();
});

it('업무 복구로 같은 대화를 연결하고 오류 제거 후 문서·대화 초안을 유지한다', async () => {
  let restored = false;
  const mock = vi.fn(async (url: string) => {
    if (url.endsWith('/reconnect')) restored = true;
    return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, state: restored ? 'idle' : 'recovery-required', error: restored ? undefined : '오래된 식별 오류', recovery: { required: !restored, canReconnect: true, code: 'legacy-workspace', mode: 'shared' } } };
  });
  vi.stubGlobal('fetch', mock); render(<WorkRoom change={change} onClose={() => {}} />);
  const button = await screen.findByRole('button', { name: '업무 복구' });
  expect(screen.getByText(/격리 공간 도입 전 업무/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: '보낼 질문 초안' } });
  fireEvent.change(await screen.findByRole('textbox', { name: '문서 내용' }), { target: { value: '문서 수정 초안' } });
  fireEvent.click(button);
  await screen.findByText('같은 대화로 복구했습니다. 문서와 작성 중인 입력은 유지됩니다.');
  expect(screen.queryByText('오래된 식별 오류')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'AI와 문답' })).toHaveValue('보낼 질문 초안');
  expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue('문서 수정 초안');
  expect(mock.mock.calls.some(([url]) => url.endsWith('/message'))).toBe(false);
});

it('손상된 격리 공간은 복구 제한을 안내하고 서버 재연결을 보내지 않는다', async () => {
  const mock = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ ...work, documents: [], state: 'recovery-required', recovery: { required: true, canReconnect: false, code: 'workspace-unavailable', mode: 'isolated' } }) }));
  vi.stubGlobal('fetch', mock); render(<WorkRoom change={change} onClose={() => {}} />);
  expect(await screen.findByRole('button', { name: '업무 복구' })).toBeDisabled();
  expect(screen.getByText(/업무 전용 폴더와 식별 정보를 복원/)).toBeInTheDocument();
  expect(mock.mock.calls.some(([url]) => url.endsWith('/reconnect'))).toBe(false);
});

it('복구 실패 시 최신 원인을 표시하고 같은 버튼으로 재시도한다', async () => {
  let attempts = 0;
  const mock = vi.fn(async (url: string) => {
    if (url.endsWith('/reconnect')) { attempts++; return { ok: attempts > 1, status: 409, json: async () => ({ message: '점유 중', errorCode: 'thread-in-use' }) }; }
    return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, state: attempts > 1 ? 'idle' : 'recovery-required', error: attempts === 1 ? '점유 중' : undefined, recovery: { required: attempts <= 1, canReconnect: true, code: attempts === 1 ? 'thread-in-use' : 'legacy-workspace', mode: 'shared' } } };
  });
  vi.stubGlobal('fetch', mock); render(<WorkRoom change={change} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '업무 복구' }));
  await screen.findByText(/다른 Codex에서 이 대화를 닫은 뒤/);
  fireEvent.click(screen.getByRole('button', { name: '업무 복구' }));
  await screen.findByText('같은 대화로 복구했습니다. 문서와 작성 중인 입력은 유지됩니다.');
  expect(attempts).toBe(2);
});

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
