import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from './test/render';
import App from './App';
vi.mock('./hooks/useApi', () => ({ useSSE: () => {}, useSources: () => ({ sources: [{ id: 'demo', name: 'demo' }], refetch: vi.fn() }), useChanges: () => ({ changes: [], refetch: vi.fn() }), useSpecs: () => ({ refetch: vi.fn() }), useIdeas: () => ({ ideas: [], refetch: vi.fn() }) }));
vi.mock('./hooks/useAiActivity', () => ({ useAiActivity: () => ({ state: 'idle', count: 0, byChange: new Map() }) }));
vi.mock('./lib/attentionStore', () => ({ claimAttention: async () => true }));
vi.mock('./components/Header', async () => { const { AttentionBell } = await import('./components/AttentionCenter'); return { Header: () => <AttentionBell /> }; });
vi.mock('./components/KanbanBoard', () => ({ KanbanBoard: () => <p>보드</p> }));
vi.mock('./components/SettingsModal', () => ({ SettingsModal: () => null }));
vi.mock('./components/IdeaCapture', () => ({ IdeaCapture: () => null }));
const item = { workId: 'w', sourceId: 'demo', changeName: 'feature', title: '알림 업무', questionId: 'q', kind: 'input', status: 'pending', createdAt: '2026-10-25T01:00:00Z' };
const work = { id: 'w', sourceId: 'demo', changeName: 'feature', phase: 'planning', state: 'waiting-input', threadId: 't', reviewedVersion: null, documents: [], events: [], questions: [{ id: 'q', kind: 'input', status: 'pending', params: { questions: [{ id: 'choice', question: '대상 질문' }] } }], verifications: [], verificationCommands: [], changes: [] };
const change = { id: 'demo/feature', sourceId: 'demo', name: 'feature', title: '알림 업무', status: 'draft', proposal: null, design: null, specs: [], tasks: null, schema: 'spec-driven', artifacts: [] };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); window.history.replaceState(null, '', '/'); delete window.desktopAttention; });
function mockFetch(currentWork = work) {
  const mock = vi.fn(async (url: string, _init?: RequestInit) => ({ ok: true, json: async () => url.endsWith('/attention') ? { items: [item] } : url === '/api/notifications/settings' ? { enabled: true, effectiveEnabled: true, dashboardUrl: 'http://localhost/', registrationStatus: 'registered', lastError: null } : url.endsWith('/trash') ? { entries: [] } : url.endsWith('/review-items') ? { items: [], errors: [], documentVersions: {} } : url.includes('/changes/') ? change : currentWork }));
  vi.stubGlobal('fetch', mock); return mock;
}
it('desktop running-app clicks use the current window and preserve drafts without POST or reload', async () => {
  let receive!: (target: { workId: string; questionId: string } | { invalid: true }) => void;
  const ready = vi.fn().mockResolvedValue(true), unsubscribe = vi.fn();
  window.desktopAttention = { onRequest: listener => { receive = listener; return unsubscribe; }, ready };
  const mock = mockFetch(); const view = render(<App />); await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  await act(async () => { receive({ workId: 'w', questionId: 'q' }); });
  await waitFor(() => expect(screen.getByRole('textbox', { name: '대상 질문' }).closest('.work-question')).toHaveFocus());
  fireEvent.change(screen.getByRole('textbox', { name: 'AI와 문답' }), { target: { value: '프로그램 초안' } });
  await act(async () => { receive({ workId: 'w', questionId: 'q' }); receive({ workId: 'w', questionId: 'q' }); });
  expect(screen.getByRole('textbox', { name: 'AI와 문답' })).toHaveValue('프로그램 초안');
  expect(mock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  await act(async () => { receive({ invalid: true }); }); expect(screen.getAllByText(/요청을 열지 못했습니다/).length).toBeGreaterThan(0);
  view.unmount(); expect(unsubscribe).toHaveBeenCalledTimes(1);
});
it('desktop readiness follows initial deep link resolution and never restores a different recent work', async () => {
  window.history.replaceState(null, '', '/?workId=w&questionId=q'); localStorage.setItem('openspec-active-change', JSON.stringify({ ...change, id: 'old/work' }));
  const ready = vi.fn().mockResolvedValue(true); window.desktopAttention = { onRequest: () => () => {}, ready };
  const mock = mockFetch(); render(<App />);
  await waitFor(() => expect(ready).toHaveBeenCalledTimes(1)); expect(window.location.search).toBe('');
  expect(mock.mock.calls.some(([url]) => url.includes('old'))).toBe(false); expect(mock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});
it('desktop navigation keeps the current work and drafts when persistence fails', async () => {
  let receive!: (target: { workId: string; questionId: string } | { invalid: true }) => void;
  window.desktopAttention = { onRequest: listener => { receive = listener; return () => {}; }, ready: vi.fn().mockResolvedValue(true) };
  mockFetch(); render(<App />); await act(async () => { receive({ workId: 'w', questionId: 'q' }); });
  const message = await screen.findByRole('textbox', { name: 'AI와 문답' }); fireEvent.change(message, { target: { value: '유지할 초안' } });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await act(async () => { receive({ workId: 'w', questionId: 'q' }); });
  expect(message).toHaveValue('유지할 초안'); expect(screen.getAllByText(/요청을 열지 못했습니다/).length).toBeGreaterThan(0);
});
it('initial notification link precedes recent work restoration and only performs reads', async () => {
  localStorage.setItem('openspec-active-change', JSON.stringify({ ...change, id: 'other/old', sourceId: 'other', name: 'old' }));
  window.history.replaceState(null, '', '/?keep=yes&workId=w&questionId=q#fragment');
  const mock = mockFetch(); render(<App />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: '대상 질문' }).closest('.work-question')).toHaveFocus());
  expect(mock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  expect(window.location.search).toBe('?keep=yes'); expect(window.location.hash).toBe('#fragment');
  expect(mock.mock.calls.some(([url]) => url.includes('other'))).toBe(false);
});
it('malformed initial link never falls back to recent work or mutates work', async () => {
  localStorage.setItem('openspec-active-change', JSON.stringify(change)); window.history.replaceState(null, '', '/?workId=w');
  const mock = mockFetch(); render(<App />); await screen.findByRole('alert');
  expect(screen.queryByRole('textbox', { name: 'AI와 문답' })).not.toBeInTheDocument();
  expect(mock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it('a delayed handled notification and repeated fresh entry never reconnect or send answers', async () => {
  const expired = { ...work, state: 'recovery-required', errorCode: 'session-restarted', questions: work.questions.map(question => ({ ...question, status: 'expired' })) };
  const mock = mockFetch(expired); window.history.replaceState(null, '', '/?workId=w&questionId=q');
  const view = render(<App />); expect(await screen.findByText(/이미 처리되었거나 만료된 요청입니다/)).toBeVisible(); view.unmount();
  window.history.replaceState(null, '', '/?workId=w&questionId=q'); render(<App />);
  expect(await screen.findByText(/이미 처리되었거나 만료된 요청입니다/)).toBeVisible();
  expect(mock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});
it('필터와 무관하게 알림에서 실제 업무·질문으로 이동하고 생성이나 승인 요청은 보내지 않는다', async () => {
  localStorage.setItem('openspec-selected-source', 'other-project');
  const fetchMock = mockFetch(); render(<App />);
  const notice = await screen.findByRole('status', { name: '응답이 필요한 요청' });
  fireEvent.click(within(notice).getByRole('button', { name: /알림 업무/ }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '대상 질문' }).closest('.work-question')).toHaveFocus());
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/changes/demo%2Ffeature')).toBe(true);
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});
it('현재 업무 초안 저장 실패 시 알림 대상 화면으로 바꾸지 않는다', async () => {
  localStorage.setItem('openspec-active-change', JSON.stringify({ ...change, title: '기존 업무' }));
  mockFetch(); render(<App />);
  const message = await screen.findByRole('textbox', { name: 'AI와 문답' });
  fireEvent.change(message, { target: { value: '보존할 초안' } });
  const notice = await screen.findByRole('status', { name: '응답이 필요한 요청' });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await act(async () => { fireEvent.click(within(notice).getByRole('button', { name: /알림 업무/ })); });
  expect(screen.getByRole('heading', { name: '기존 업무' })).toBeVisible();
  expect(message).toHaveValue('보존할 초안');
  expect(screen.getAllByText(/요청을 열지 못했습니다/).length).toBeGreaterThan(0);
});
