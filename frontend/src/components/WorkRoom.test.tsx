import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkRoom } from './WorkRoom';
import type { Change } from '../types';
const change = { id: 'demo/feature', name: 'feature', sourceId: 'demo' } as Change;
const work = { id: 'work-1', sourceId: 'demo', changeName: 'feature', phase: 'planning', state: 'idle', threadId: null, reviewedVersion: null,
  documents: ['proposal.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] };
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
it('HTTP 상태 이름보다 구체적인 충돌 원인을 표시한다', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/message')
    ? { ok: false, json: async () => ({ error: 'Conflict', message: '다른 Codex 앱에서 이 업무 대화를 사용 중입니다.' }) }
    : { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : work }));
  render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: '다시 진행' } });
  fireEvent.click(screen.getByRole('button', { name: '보내기' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('다른 Codex 앱');
  expect(screen.getByRole('textbox', { name: 'AI와 문답' })).toHaveValue('다시 진행');
});
it('복구 버튼은 메시지를 보내지 않고 기존 대화만 다시 연결한다', async () => {
  let recovered = false;
  const mock = vi.fn(async (url: string) => {
    if (url.endsWith('/reconnect')) recovered = true;
    return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, threadId: 'same-thread', state: recovered ? 'idle' : 'recovery-required', error: recovered ? undefined : 'thread same-thread already has an active writer' } };
  });
  vi.stubGlobal('fetch', mock);
  render(<WorkRoom change={change} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '같은 대화 다시 연결' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '같은 대화 다시 연결' })).not.toBeInTheDocument());
  expect(mock.mock.calls.filter(([url]) => url.endsWith('/reconnect'))).toHaveLength(1);
  expect(mock.mock.calls.some(([url]) => url.endsWith('/message'))).toBe(false);
});
it('Ctrl+Enter로 한 번 전송하고 처리 중에는 중복 전송하지 않는다', async () => {
  let finish!: () => void;
  const sending = new Promise<void>(resolve => { finish = resolve; });
  const mock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/message')) await sending;
    return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : work };
  });
  vi.stubGlobal('fetch', mock);
  render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  const input = screen.getByRole('textbox', { name: 'AI와 문답' });
  fireEvent.change(input, { target: { value: '단축키로 수정 요청' } });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(mock.mock.calls.filter(([url]) => url.endsWith('/message'))).toHaveLength(1));
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  expect(mock.mock.calls.filter(([url]) => url.endsWith('/message'))).toHaveLength(1);
  expect(JSON.parse(mock.mock.calls.find(([url]) => url.endsWith('/message'))![1]!.body as string).text).toContain('단축키로 수정 요청');
  finish();
  await waitFor(() => expect(input).toHaveValue(''));
});
it('일반 Enter와 한글 조합·키 반복·빈 입력은 전송하지 않는다', async () => {
  const mock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : work }));
  vi.stubGlobal('fetch', mock);
  render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  const input = screen.getByRole('textbox', { name: 'AI와 문답' });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  fireEvent.change(input, { target: { value: '작성 중' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, keyCode: 229 });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, repeat: true });
  expect(mock.mock.calls.some(([url]) => url.endsWith('/message'))).toBe(false);
  expect(input).toHaveValue('작성 중');
});
it('문서와 같은 대화를 유지하며 수정 요청을 보낸다', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/document')) return { ok: true, json: async () => ({ path: 'proposal.md', content: '# 초안', version: 'v1' }) };
    if (url.includes('/message')) { expect(JSON.parse(init!.body as string).text).toContain('다시 수정'); return { ok: true, json: async () => work }; }
    return { ok: true, json: async () => work };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<WorkRoom change={change} onClose={() => {}} />);
  expect(await screen.findByRole('textbox', { name: 'AI와 문답' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: '다시 수정' } });
  fireEvent.click(screen.getByRole('button', { name: '보내기' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.includes('/message'))).toBe(true));
  expect(screen.getByText('문서')).toBeInTheDocument();
});
it('업무를 다시 열면 미저장 초안과 기준 버전을 복원한다', async () => {
  localStorage.setItem('work-draft:work-1:proposal.md', JSON.stringify({ content: '# 보존된 초안', version: 'v1' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '# 서버 최신 문서', version: 'v2' } : work })));
  render(<WorkRoom change={change} onClose={() => {}} />);
  expect(await screen.findByRole('textbox', { name: '문서 내용' })).toHaveValue('# 보존된 초안'); expect(screen.getByText('미저장 초안')).toBeInTheDocument();
});
it('미저장 문서가 있으면 이동을 취소할 수 있고 AI 요청을 차단한다', async () => {
  const close = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '# 원본', version: 'v1' } : work })));
  render(<WorkRoom change={change} onClose={close} />);
  const editor = await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.change(editor, { target: { value: '# 보존할 초안' } });
  fireEvent.click(screen.getByRole('button', { name: '← 보드로 돌아가기' }));
  expect(close).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(editor).toHaveValue('# 보존할 초안');
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: '수정해 줘' } }); fireEvent.click(screen.getByRole('button', { name: '보내기' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('먼저 저장');
});
it('저장 응답을 기다리는 동안 편집을 잠가 입력 유실을 막는다', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return new Promise(resolve => { finish = resolve; });
    return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '# 원본', version: 'v1' } : work };
  }));
  render(<WorkRoom change={change} onClose={() => {}} />);
  const editor = await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.change(editor, { target: { value: '# 수정' } }); fireEvent.click(screen.getByRole('button', { name: '문서 저장' }));
  expect(editor).toBeDisabled(); finish({ ok: true, json: async () => ({ path: 'proposal.md', content: '# 수정', version: 'v2' }) });
  await waitFor(() => expect(editor).not.toBeDisabled()); expect(editor).toHaveValue('# 수정');
});
it('저장 충돌 시 최신 문서와 초안을 비교하고 명시적으로 재적용한다', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/document') && init?.method === 'PUT') return { ok: false, json: async () => ({ error: '문서 충돌', latest: { path: 'proposal.md', content: '# 최신 문서', version: 'v2' } }) };
    if (url.includes('/document')) return { ok: true, json: async () => ({ path: 'proposal.md', content: '# 초안', version: 'v1' }) };
    return { ok: true, json: async () => work };
  });
  vi.stubGlobal('fetch', fetchMock); render(<WorkRoom change={change} onClose={() => {}} />);
  const editor = await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.change(editor, { target: { value: '# 내 수정' } }); fireEvent.click(screen.getByRole('button', { name: '문서 저장' }));
  expect(await screen.findByText('# 최신 문서')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue('# 내 수정');
  fireEvent.click(screen.getByRole('button', { name: '최신 버전에 내 초안 재적용' }));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2));
  expect(JSON.parse(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')[1][1]!.body as string).version).toBe('v2');
});
it('SSE 재전송은 중복 조회하지 않고 연결 복구 상태를 표시한다', async () => {
  class Stream { static current: Stream; callbacks: Record<string, (event: { data: string }) => void> = {}; onopen?: () => void; onerror?: () => void; close = vi.fn(); constructor() { Stream.current = this; } addEventListener(name: string, callback: (event: { data: string }) => void) { this.callbacks[name] = callback; } }
  vi.stubGlobal('EventSource', Stream);
  const mock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : work })); vi.stubGlobal('fetch', mock);
  const { unmount } = render(<WorkRoom change={change} onClose={() => {}} />); await screen.findByRole('textbox', { name: '문서 내용' });
  await waitFor(() => expect(Stream.current).toBeDefined());
  const before = mock.mock.calls.length;
  act(() => { Stream.current.callbacks['work-update']({ data: JSON.stringify({ seq: 10 }) }); Stream.current.callbacks['work-update']({ data: JSON.stringify({ seq: 10 }) }); });
  await waitFor(() => expect(mock.mock.calls.length).toBe(before + 1));
  act(() => Stream.current.onerror?.()); expect(screen.getByText('세션 정보 · 재연결 중 · 저장된 업무 유지')).toBeInTheDocument();
  act(() => Stream.current.onopen?.()); expect(screen.getByText('세션 정보 · 실시간 연결됨')).toBeInTheDocument(); unmount(); expect(Stream.current.close).toHaveBeenCalled();
});
it('만료 질문을 같은 업무 대화로 복구하고 모바일 영역을 전환한다', async () => {
  const mock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, state: 'recovery-required', error: 'Codex 인증 또는 연결 확인 필요', questions: [{ id: 'q1', kind: 'input', status: 'expired', params: { questions: [{ id: 'choice', question: '복구할 결정은?' }] } }] } })); vi.stubGlobal('fetch', mock);
  render(<WorkRoom change={change} onClose={() => {}} />); await screen.findByRole('textbox', { name: '복구할 결정은?' });
  expect(screen.getByText(/Codex 인증 또는 연결 확인 필요/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: '복구할 결정은?' }), { target: { value: '결정한 방식' } }); fireEvent.click(screen.getByRole('button', { name: '같은 대화로 답변 복구' }));
  await waitFor(() => expect(mock.mock.calls.some(([url]) => url.endsWith('/answer'))).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: '문서·결과' })); expect(screen.getByRole('button', { name: '문서·결과' })).toHaveAttribute('aria-pressed', 'true');
});
it('검증의 최신성을 표시하고 명시적인 결과 확인으로 완료를 요청한다', async () => {
  const mock = vi.fn(async (url: string, _init?: RequestInit) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, phase: 'verification', verifications: [{ id: 'v', commandId: 'test', status: 'passed', fresh: false, stdout: '결과', stderr: '', code: 0 }] } })); vi.stubGlobal('fetch', mock);
  render(<WorkRoom change={change} onClose={() => {}} />); await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.click(screen.getByRole('button', { name: '코드·실행·검증' })); expect(screen.getByText(/과거 결과·재검증 필요/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '결과 확인·완료' }));
  await waitFor(() => expect(mock.mock.calls.some(([url]) => url.endsWith('/action'))).toBe(true));
  expect(JSON.parse(mock.mock.calls.find(([url]) => url.endsWith('/action'))![1]!.body as string)).toEqual({ action: 'complete', confirmed: true });
});
it('OpenSpec 오류를 구분하고 같은 대화로 수정 요청을 준비한다', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/openspec?') ? { ok: false, code: 1, stdout: '', stderr: '시나리오가 없습니다' } : url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : work })));
  render(<WorkRoom change={change} onClose={() => {}} />); await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.click(screen.getByRole('button', { name: 'OpenSpec' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'OpenSpec 기능' }), { target: { value: 'validate' } }); fireEvent.click(screen.getByRole('button', { name: '조회·검증' }));
  expect(await screen.findByText('오류·미지원 또는 검증 실패')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '이 결과로 AI 수정 요청 준비' })); expect((screen.getByRole('textbox', { name: 'AI와 문답' }) as HTMLTextAreaElement).value).toContain('시나리오가 없습니다');
});
