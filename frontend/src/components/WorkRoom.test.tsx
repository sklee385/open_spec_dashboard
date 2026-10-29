import { render } from '../test/render';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkRoom } from './WorkRoom';
import type { Change } from '../types';
const change = { id: 'demo/feature', name: 'feature', sourceId: 'demo' } as Change;
const work = { id: 'work-1', sourceId: 'demo', changeName: 'feature', phase: 'planning', state: 'idle', threadId: null, reviewedVersion: null,
  documents: ['proposal.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
it('외부 점유 업무에 새 세션 복구를 제공하고 모바일 연결은 모든 업무에서 안내한다', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, threadId: 'old-thread', state: 'recovery-required', errorCode: 'thread-in-use' } })));
  render(<WorkRoom change={change} onClose={() => {}} />);
  expect(await screen.findByRole('button', { name: '복구용 새 세션으로 이어하기' })).toBeEnabled();
  expect(screen.getByText('모바일 Codex 연결')).toBeVisible();
});
it('문서 목록에서 verification.md를 선택해 검증 기록 원문과 미리보기를 연다', async () => {
  const mock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document')
    ? { path: new URL(url, 'http://localhost').searchParams.get('path'), content: url.includes('verification.md') ? '# 검증 결과\n488개 통과' : '# 계획', version: 'v1' }
    : { ...work, documents: ['proposal.md', 'verification.md'] } }));
  vi.stubGlobal('fetch', mock); render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('option', { name: 'verification.md' });
  fireEvent.change(screen.getByRole('combobox', { name: '문서 선택' }), { target: { value: 'verification.md' } });
  await waitFor(() => expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue('# 검증 결과\n488개 통과'));
  fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
  expect(await screen.findByRole('heading', { name: '검증 결과' })).toBeVisible();
});
it('저장된 외부 도구 이름과 기능 제한을 표시하고 고유 재개와 승인 동작을 제공하지 않는다', async () => {
  const room = { ...work, toolId: 'local', toolConfigSnapshot: { name: '저장된 로컬 CLI', kind: 'external-cli' }, toolCapabilities: { conversation: true, questions: false, approval: false, interrupt: true, nativeResume: false }, state: 'recovery-required', threadId: 'old', errorCode: 'session-restarted',
    events: [{ seq: 1, type: 'item/agentMessage/delta', data: { turnId: 't', itemId: 'i', delta: '외부 응답' } }],
    questions: [{ id: 'q', kind: 'approval', status: 'pending', method: 'item/commandExecution/requestApproval', params: {} }] };
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : room }));
  vi.stubGlobal('fetch', fetch); render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByText('외부 응답');
  expect(screen.getAllByText('저장된 로컬 CLI').length).toBeGreaterThan(0);
  expect(screen.getByText(/구조화 질문·승인·고유 세션 재개 미지원/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '같은 대화 다시 연결' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '이 요청 승인' })).not.toBeInTheDocument();
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/reconnect') || url.includes('/ai-tools'))).toBe(false);
});
it('계획 버튼 옆 사용자 검토 진행으로 같은 업무의 검토를 요청한다', async () => {
  const mock = vi.fn(async (url: string, _options?: RequestInit) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : work }));
  vi.stubGlobal('fetch', mock); render(<WorkRoom change={change} onClose={() => {}} />);
  const button = await screen.findByRole('button', { name: '사용자 검토 진행' });
  await waitFor(() => expect(button).toBeEnabled());
  expect(screen.getByRole('button', { name: 'AI와 계획 작성·수정' }).nextElementSibling).toBe(button);
  fireEvent.click(button);
  await waitFor(() => expect(mock.mock.calls.some(([url, options]) => url === '/api/work/work-1/action' && JSON.parse(String(options?.body)).action === 'guided-review')).toBe(true));
  expect(mock.mock.calls.some(([url]) => url.endsWith('/message') || url.endsWith('/answer'))).toBe(false);
});
it('미저장 초안이 있으면 저장 안내 후 검토 요청을 보내지 않는다', async () => {
  const mock = vi.fn(async (url: string, _options?: RequestInit) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : work }));
  vi.stubGlobal('fetch', mock); render(<WorkRoom change={change} onClose={() => {}} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '문서 내용' }), { target: { value: '저장하지 않은 내용' } });
  fireEvent.click(screen.getByRole('button', { name: '사용자 검토 진행' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('저장');
  expect(mock.mock.calls.some(([url]) => url.endsWith('/action'))).toBe(false);
  expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue('저장하지 않은 내용');
});
it.each(['running', 'waiting-input', 'waiting-approval', 'recovery-required'])('%s 중 사용자 검토를 중복 시작하지 않는다', async state => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, state } })));
  render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  expect(screen.getByRole('button', { name: '사용자 검토 진행' })).toBeDisabled();
});
it('외부 도구의 사용자 검토 버튼은 비활성화 이유를 표시한다', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, toolCapabilities: { questions: false } } })));
  render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  expect(screen.getByRole('button', { name: '사용자 검토 진행' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '사용자 검토 진행' })).toHaveAttribute('title', expect.stringContaining('구조화 질문'));
});

it('업무를 열고 새 대화가 추가되면 최신 메시지로 이동한다', async () => {
  let events = [{ seq: 1, type: 'user-message', data: { text: '처음 대화' } }];
  class Stream { static current: Stream; callbacks: Record<string, (event: { data: string }) => void> = {}; close() {} addEventListener(name: string, callback: (event: { data: string }) => void) { this.callbacks[name] = callback; } constructor() { Stream.current = this; } }
  vi.stubGlobal('EventSource', Stream);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, events } })));
  const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
  try {
    const view = render(<WorkRoom change={change} onClose={() => {}} />);
    await screen.findByText('처음 대화');
    const messages = view.container.querySelector('.work-messages')!;
    await waitFor(() => expect(messages.scrollTop).toBe(900));
    messages.scrollTop = 0;
    events = [...events, { seq: 2, type: 'user-message', data: { text: '최신 대화' } }];
    act(() => Stream.current.callbacks['work-update']({ data: JSON.stringify({ seq: 2 }) }));
    await screen.findByText('최신 대화');
    await waitFor(() => expect(messages.scrollTop).toBe(900));
  } finally { height.mockRestore(); }
});

it('권한 요청을 이유·명령·경로로 설명하고 기존 승인 요청을 보낸다', async () => {
  const mock = vi.fn(async (url: string, _init?: RequestInit) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, questions: [{ id: 'approval-1', kind: 'approval', status: 'pending', method: 'item/commandExecution/requestApproval', params: { reason: '테스트 실행을 위해 필요합니다', command: 'npm test', cwd: 'D:/project' } }] } }));
  vi.stubGlobal('fetch', mock);
  render(<WorkRoom change={change} onClose={() => {}} />);
  expect(await screen.findByText('테스트 실행을 위해 필요합니다')).toBeVisible();
  expect(screen.getByText('요청 이유')).toBeVisible();
  expect(screen.getByText('작업 경로')).toBeVisible();
  expect(screen.getByText('D:/project')).toBeVisible();
  expect(screen.getByText('원본 요청').closest('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: '이 요청 승인' }));
  await waitFor(() => expect(mock.mock.calls.some(([url, init]) => url.endsWith('/approval') && JSON.parse(init!.body as string).decision === 'accept')).toBe(true));
});

it('사용자와 AI 대화의 표·제목·목록을 마크다운으로 표시한다', async () => {
  const table = '| 항목 | 이전 설계 | 변경 설계 |\n|---|---|---|\n| 수신 범위 | 탭이 열려 있어야 함 | 세션 서버 실행 중 |';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, events: [
    { seq: 1, type: 'user-message', data: { text: table } },
    { seq: 2, type: 'item/completed', data: { turnId: 'turn', item: { id: 'msg', type: 'agentMessage', text: `## 변경 안내\n\n${table}\n\n- [x] **알림** 적용\n  - 하위 항목\n\n~~이전 방식~~\n\n[설명](https://example.com)` } } },
  ] } })));
  const view = render(<WorkRoom change={change} onClose={() => {}} />);
  expect(await screen.findByRole('heading', { name: '변경 안내' })).toBeVisible();
  expect(screen.getAllByRole('table')).toHaveLength(2);
  expect(screen.getAllByRole('columnheader', { name: '변경 설계' })).toHaveLength(2);
  expect(screen.getAllByRole('cell', { name: '세션 서버 실행 중' })).toHaveLength(2);
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(screen.getByText('하위 항목').closest('ul')?.parentElement?.tagName).toBe('LI');
  expect(screen.getByText('이전 방식').tagName).toBe('DEL');
  expect(screen.getByRole('link', { name: '설명' })).toHaveAttribute('href', 'https://example.com');
  for (const tableElement of view.container.querySelectorAll('.work-message table')) {
    expect(tableElement.parentElement).toHaveClass('markdown-scroll');
  }
});

it('대화의 코드와 JSON을 구분해 표시하고 복사한다', async () => {
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '내용', version: 'v1' } : { ...work, events: [{ seq: 1, type: 'item/completed', data: { turnId: 'turn', item: { id: 'msg', type: 'agentMessage', text: '```json\n{"ready":true}\n```\n\n```typescript\nconst count = 1;\n```' } } }] } })));
  try {
    const view = render(<WorkRoom change={change} onClose={() => {}} />);
    await screen.findByText('typescript');
    const code = view.container.querySelector('code.language-json')!;
    expect(code.textContent).toBe('{\n  "ready": true\n}');
    expect(code.querySelector('.syntax-key')).not.toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: '코드 복사' })[0]);
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('{\n  "ready": true\n}'));
  } finally { if (previous) Object.defineProperty(navigator, 'clipboard', previous); else Reflect.deleteProperty(navigator, 'clipboard'); }
});
it('새로 열어도 선택 문서와 초안·화면 탭을 같은 업무로 복원한다', async () => {
  const mock = vi.fn(async (url: string, _init?: RequestInit) => ({ ok: true, json: async () => url.includes('/document')
    ? { path: new URL(url, 'http://localhost').searchParams.get('path'), content: '서버 문서', version: 'v1' }
    : { ...work, threadId: 'same-thread', documents: ['proposal.md', 'design.md'] } }));
  vi.stubGlobal('fetch', mock);
  const first = render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.change(screen.getByRole('combobox', { name: '문서 선택' }), { target: { value: 'design.md' } });
  await waitFor(() => expect(mock.mock.calls.some(([url]) => url.endsWith('path=design.md'))).toBe(true));
  await waitFor(() => expect(screen.getByRole('button', { name: '문서 저장' })).toBeDisabled());
  fireEvent.change(screen.getByRole('textbox', { name: '문서 내용' }), { target: { value: '설계 미저장 초안' } });
  fireEvent.click(screen.getByRole('button', { name: '문서·결과' }));
  fireEvent.click(screen.getByRole('button', { name: '코드·실행·검증' }));
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  first.unmount();
  render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByText('Codex same-thread');
  expect(screen.getByRole('button', { name: '문서·결과' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: '코드·실행·검증' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '문서' }));
  expect(await screen.findByRole('textbox', { name: '문서 내용' })).toHaveValue('설계 미저장 초안');
  expect(screen.getByRole('combobox', { name: '문서 선택' })).toHaveValue('design.md');
  const starts = mock.mock.calls.filter(([url]) => url === '/api/work');
  expect(starts).toHaveLength(2);
  expect(starts.map(([, init]) => JSON.parse(init!.body as string).requestKey)).toEqual(['change:demo/feature', 'change:demo/feature']);
  expect(mock.mock.calls.filter(([url]) => /^\/api\/work\/[^/]+$/.test(url)).every(([url]) => url === '/api/work/work-1')).toBe(true);
});

it('이벤트가 없는 재연결에서도 업무 상태를 다시 조회하고 초안을 유지한다', async () => {
  class Stream { static current: Stream; onopen?: () => void; onerror?: () => void; close() {} addEventListener() {} constructor() { Stream.current = this; } }
  vi.stubGlobal('EventSource', Stream);
  let state = 'idle';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '서버 문서', version: 'v1' } : { ...work, state } })));
  render(<WorkRoom change={change} onClose={() => {}} />);
  const editor = await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.change(editor, { target: { value: '재연결 중에도 유지할 초안' } });
  act(() => Stream.current.onerror?.());
  state = 'waiting-input';
  act(() => Stream.current.onopen?.());
  await screen.findByText('아이디어·문서 작성 · 답변 대기');
  expect(editor).toHaveValue('재연결 중에도 유지할 초안');
});

it.each(['{broken', JSON.stringify({ pane: 'missing', tab: 'missing', path: '../other.md' })])('저장된 화면 정보가 잘못되면 현재 업무의 첫 문서로 복원한다: %s', async saved => {
  localStorage.setItem(`work-view:${change.id}`, saved);
  const mock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '현재 업무 문서', version: 'v1' } : work }));
  vi.stubGlobal('fetch', mock);
  render(<WorkRoom change={change} onClose={() => {}} />);
  expect(await screen.findByRole('textbox', { name: '문서 내용' })).toHaveValue('현재 업무 문서');
  expect(screen.getByRole('button', { name: '대화·질문' })).toHaveAttribute('aria-pressed', 'true');
  expect(mock.mock.calls.some(([url]) => url.includes('other.md'))).toBe(false);
});
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
  fireEvent.click(await screen.findByRole('button', { name: '업무 복구' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '업무 복구' })).not.toBeInTheDocument());
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
