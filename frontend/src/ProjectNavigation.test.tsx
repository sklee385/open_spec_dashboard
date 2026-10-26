import { useEffect, useState } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from './test/render';
import App from './App';
const state = vi.hoisted(() => ({ mayLeave: true }));
vi.mock('./hooks/useApi', () => ({ useSSE: () => {}, useSources: () => ({ sources: [{ id: 'demo', name: 'Demo' }, { id: 'other', name: 'Other' }], refetch: vi.fn() }), useChanges: () => ({ changes: [], refetch: vi.fn() }), useSpecs: () => ({ refetch: vi.fn() }), useIdeas: () => ({ ideas: [], refetch: vi.fn() }) }));
vi.mock('./hooks/useAiActivity', () => ({ useAiActivity: () => ({ state: 'idle', count: 0, byChange: new Map() }) }));
vi.mock('./components/Header', () => ({ Header: (p: { onViewChange: (view: 'project' | 'kanban') => void; onSourceChange: (id: string) => void }) => <><button onClick={() => p.onViewChange('project')}>소스·Git 열기</button><button onClick={() => p.onViewChange('kanban')}>보드 열기</button><button onClick={() => p.onSourceChange('other')}>다른 프로젝트</button></> }));
vi.mock('./components/KanbanBoard', () => ({ KanbanBoard: () => <p>개발 보드</p> }));
vi.mock('./components/SpecsView', () => ({ SpecsView: () => <p>명세 화면</p> }));
vi.mock('./components/SettingsModal', () => ({ SettingsModal: () => null }));
vi.mock('./components/IdeaCapture', () => ({ IdeaCapture: () => null }));
vi.mock('./components/ProjectWorkspace', () => ({ ProjectWorkspace: (p: { sourceId: string; workId?: string; registerNavigationGuard?: (guard: () => Promise<boolean>) => void; onWorkScopeChange?: (id: string) => void; onOpenWork?: () => void }) => { const { registerNavigationGuard } = p; useEffect(() => { registerNavigationGuard?.(async () => state.mayLeave); }, [registerNavigationGuard]); return <section><p>소스 프로젝트: {p.sourceId}</p><p>선택 공간: {p.workId || '원본'}</p><button onClick={() => p.onWorkScopeChange?.('w')}>업무 공간 선택</button><button onClick={p.onOpenWork}>업무로 돌아가기</button></section>; } }));
vi.mock('./components/WorkRoom', () => ({ WorkRoom: (p: { onOpenSource?: () => void }) => { const [draft, setDraft] = useState(''); return <section><input aria-label="대화 초안" value={draft} onChange={e => setDraft(e.target.value)} /><button onClick={p.onOpenSource}>프로젝트 코드 열기</button></section>; } }));
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); state.mayLeave = true; });
function setup() { vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [], entries: [] }) }))); localStorage.setItem('openspec-selected-source', 'demo'); }

it('독립 소스 화면을 열고 미저장 이동 취소 시 화면·프로젝트를 유지한다', async () => {
  setup(); render(<App />);
  fireEvent.click(screen.getByText('소스·Git 열기'));
  expect(await screen.findByText('소스 프로젝트: demo')).toBeVisible();
  state.mayLeave = false;
  fireEvent.click(screen.getByText('보드 열기')); fireEvent.click(screen.getByText('다른 프로젝트'));
  await waitFor(() => expect(screen.getByText('소스 프로젝트: demo')).toBeVisible());
  expect(screen.queryByText('개발 보드')).not.toBeInTheDocument();
  state.mayLeave = true;
  fireEvent.click(screen.getByText('보드 열기')); expect(await screen.findByText('개발 보드')).toBeVisible();
});

it('업무에서 코드로 이동하고 복귀해도 대화 초안과 같은 업무를 유지한다', async () => {
  setup(); localStorage.setItem('openspec-active-change', JSON.stringify({ id: 'demo/feature', sourceId: 'demo', name: 'feature', status: 'draft' }));
  const mock = vi.mocked(fetch); render(<App />);
  fireEvent.change(screen.getByRole('textbox', { name: '대화 초안' }), { target: { value: '유지할 대화' } });
  fireEvent.click(screen.getByText('프로젝트 코드 열기'));
  expect(await screen.findByText('소스 프로젝트: demo')).toBeVisible();
  expect(screen.getByRole('textbox', { name: '대화 초안', hidden: true })).not.toBeVisible();
  fireEvent.click(screen.getByText('업무로 돌아가기'));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '대화 초안' })).toHaveValue('유지할 대화'));
  expect(mock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('앱 내부에서 업무 공간을 선택하고 연결된 업무를 열 수 있다', async () => {
  setup(); vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url === '/api/work' ? { work: [{ id: 'w', sourceId: 'demo', changeName: 'feature', phase: 'implementation', executionPath: '/isolated' }] } : { items: [], entries: [] } })));
  render(<App />); fireEvent.click(screen.getByText('소스·Git 열기'));
  expect(await screen.findByText('선택 공간: 원본')).toBeVisible();
  fireEvent.click(screen.getByText('업무 공간 선택'));
  expect(await screen.findByText('선택 공간: w')).toBeVisible();
  fireEvent.click(screen.getByText('업무로 돌아가기'));
  expect(await screen.findByRole('textbox', { name: '대화 초안' })).toBeVisible();
});
