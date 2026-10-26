import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from './test/render';
import App from './App';
import { useCallback, useState } from 'react';

const state = vi.hoisted(() => ({
  saved: [{ name: 'other', path: '/other' }],
  changes: vi.fn(), specs: vi.fn(), sources: vi.fn(), ideas: vi.fn(),
  specsData: [{ id: 'demo/old', sourceId: 'demo', path: 'old/spec.md' }],
}));
vi.mock('./hooks/useApi', () => ({ useSSE: () => {},
  useSources: () => ({ sources: [{ id: 'demo', name: 'Demo' }, { id: 'other', name: 'Other' }], refetch: state.sources }),
  useChanges: () => ({ changes: [], refetch: state.changes }),
  useSpecs: () => { const [specs, setSpecs] = useState(() => [...state.specsData]); const refetch = useCallback(() => { state.specs(); setSpecs([...state.specsData]); }, []); return { specs, refetch, loading: false }; },
  useSpec: (id: string | null) => ({ spec: id ? { id, path: 'old/spec.md', content: '제거할 명세 원문' } : null, loading: false }),
  useIdeas: () => ({ ideas: [], refetch: state.ideas }),
}));
vi.mock('./hooks/useAiActivity', () => ({ useAiActivity: () => ({ state: 'idle', count: 0, byChange: new Map() }) }));
vi.mock('./hooks/useMediaQuery', () => ({ useIsMobile: () => false }));
vi.mock('./components/Header', () => ({ Header: (p: { selectedSourceId: string | null; onOpenSources: (trigger: HTMLElement) => void; onOpenSettings: () => void }) => <><p>선택: {p.selectedSourceId || '전체'}</p><button onClick={e => p.onOpenSources(e.currentTarget)}>소스 관리</button><button onClick={p.onOpenSettings}>설정</button></> }));
vi.mock('./components/SourceManagementModal', () => ({ SourceManagementModal: (p: { open: boolean; onSaved: (sources: typeof state.saved) => void; onOpenChange: (open: boolean) => void }) => p.open ? <section role="dialog" aria-label="소스 관리"><button onClick={() => { state.specsData = [{ id: 'other/new', sourceId: 'other', path: 'new/spec.md' }]; p.onSaved(state.saved); }}>소스 저장</button><button onClick={() => p.onOpenChange(false)}>닫기</button></section> : null }));
vi.mock('./components/SettingsModal', () => ({ SettingsModal: (p: { open: boolean }) => p.open ? <p>프로그램 설정</p> : null }));
vi.mock('./components/KanbanBoard', () => ({ KanbanBoard: (p: { onOpenSources: () => void }) => <button onClick={p.onOpenSources}>빈 보드 소스 등록</button> }));
vi.mock('./components/IdeaCapture', () => ({ IdeaCapture: () => null }));

afterEach(() => { localStorage.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); state.specsData = [{ id: 'demo/old', sourceId: 'demo', path: 'old/spec.md' }]; });
function setup() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [], entries: [] }) })));
  localStorage.setItem('openspec-selected-source', 'demo');
  render(<App />);
}

it.each([false, true])('소스 변경 후 선택 유지(%s)와 모든 목록을 갱신한다', async retain => {
  state.saved = retain ? [{ name: 'demo', path: '/demo' }] : [{ name: 'other', path: '/other' }];
  setup(); fireEvent.click(screen.getByText('소스 관리'));
  fireEvent.click(screen.getByText('소스 저장'));
  await waitFor(() => expect(screen.getByText(`선택: ${retain ? 'demo' : '전체'}`)).toBeInTheDocument());
  expect(localStorage.getItem('openspec-selected-source')).toBe(retain ? 'demo' : null);
  for (const spy of [state.sources, state.changes, state.specs, state.ideas]) expect(spy).toHaveBeenCalled();
});

it('설정과 중첩하지 않고 빈 보드에서도 소스 관리를 연다', () => {
  setup(); fireEvent.click(screen.getByText('설정'));
  expect(screen.getByText('프로그램 설정')).toBeInTheDocument();
  fireEvent.click(screen.getByText('빈 보드 소스 등록'));
  expect(screen.getByRole('dialog', { name: '소스 관리' })).toBeInTheDocument();
  expect(screen.queryByText('프로그램 설정')).not.toBeInTheDocument();
});

it('명세 화면을 연 채 소스를 변경해도 실제 표시 목록을 갱신한다', async () => {
  state.saved = [{ name: 'other', path: '/other' }];
  localStorage.setItem('openspec-view', 'specs');
  setup();
  await waitFor(() => expect(screen.getByText('old/spec.md')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'old/spec.md' }));
  await screen.findByText('제거할 명세 원문');
  fireEvent.click(screen.getByText('소스 관리')); fireEvent.click(screen.getByText('소스 저장'));
  fireEvent.click(screen.getByText('닫기'));
  await waitFor(() => expect(screen.getByText('new/spec.md')).toBeInTheDocument());
  expect(screen.queryByText('old/spec.md')).not.toBeInTheDocument();
  expect(screen.queryByText('제거할 명세 원문')).not.toBeInTheDocument();
});
