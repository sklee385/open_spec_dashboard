import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { Header } from '../components/Header';
import { KanbanBoard } from '../components/KanbanBoard';
import { IdeaCapture } from '../components/IdeaCapture';
import { IdeaDetailModal } from '../components/IdeaDetailModal';
import { SettingsModal } from '../components/SettingsModal';
import { SourceManagementModal } from '../components/SourceManagementModal';
import { SpecsView } from '../components/SpecsView';
import { WorkRoom } from '../components/WorkRoom';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { DetailModal } from '../components/DetailModal';
import { ChangeCard } from '../components/ChangeCard';
import type { Change, Idea } from '../types';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
it('한국어 헤더의 접근성 이름과 메뉴를 제공한다', () => {
  render(<Header currentView="kanban" onViewChange={() => {}} sources={[]} selectedSourceId={null} onSourceChange={() => {}} />);
  expect(screen.getAllByRole('button', { name: '설정 열기' }).length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: '메뉴 열기' })).toBeInTheDocument();
  expect(screen.getByText('전체 프로젝트')).toBeInTheDocument();
});
it('한국어 보드의 빈 화면을 제공한다', () => {
  render(<KanbanBoard changes={[]} ideas={[]} sources={[]} onCardClick={() => {}} selectedSourceId={null} />);
  expect(screen.getByText('설정된 OpenSpec 소스가 없습니다')).toBeInTheDocument();
});
it('한국어 명세 빈 화면을 제공한다', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ specs: [] }) })));
  render(<SpecsView selectedSourceId={null} />);
  expect(await screen.findByText('명세가 없습니다')).toBeInTheDocument();
});
it('한국어 아이디어 입력을 원문으로 저장한다', async () => {
  const fetch = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ sources: [], idea: {} }) }));
  vi.stubGlobal('fetch', fetch);
  render(<IdeaCapture open />);
  fireEvent.change(screen.getByLabelText('제목'), { target: { value: 'Original 제목' } });
  fireEvent.change(screen.getByLabelText('설명'), { target: { value: '원문 body' } });
  fireEvent.click(screen.getByRole('button', { name: '아이디어 저장' }));
  await waitFor(() => expect(fetch.mock.calls.some(call => JSON.stringify(call).includes('Original 제목'))).toBe(true));
});
it('영어 아이디어의 콘텐츠는 한국어 원문을 보존한다', () => {
  const idea = { id: 'demo/i', title: '원문 제목', description: '원문 설명', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' } as Idea;
  render(<IdeaDetailModal idea={idea} onClose={() => {}} onStart={vi.fn()} />, { locale: 'en' });
  expect(screen.getByText('원문 제목')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Change name' })).toBeInTheDocument();
});
it('한국어 설정 화면을 표시한다', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ tools: [], defaultToolId: 'codex', version: 'v1' }) })));
  render(<SettingsModal open onOpenChange={() => {}} />);
  expect(screen.getByRole('dialog', { name: '설정' })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: '외부 도구 추가' })).toBeInTheDocument();
  expect(screen.queryByText('새 소스 추가')).not.toBeInTheDocument();
});
it('한국어 소스 관리 화면을 표시한다', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ sources: [] }) })));
  render(<SourceManagementModal open onOpenChange={() => {}} />);
  expect(await screen.findByText('새 소스 추가')).toBeInTheDocument();
});
it('영어 업무 공간에서도 사용자 메시지 역할과 AI 요청은 원문을 유지한다', async () => {
  const work = { id: 'w', phase: 'planning', state: 'idle', documents: ['proposal.md'], events: [{ seq: 1, type: 'user-message', data: { text: '원문 질문' } }], questions: [], verifications: [], verificationCommands: [], changes: [] };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => { void init; return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '# 원문 문서', version: 'v1' } : work }; });
  vi.stubGlobal('fetch', fetch);
  const { container } = render(<WorkRoom change={{ id: 'demo/c', name: 'c', sourceId: 'demo' } as Change} onClose={() => {}} />, { locale: 'en' });
  expect(await screen.findByText('원문 질문')).toBeInTheDocument();
  expect(container.querySelector('.work-message.user')).toHaveTextContent('Me');
  expect(await screen.findByRole('textbox', { name: 'Document content' })).toHaveValue('# 원문 문서');
  fireEvent.change(screen.getByRole('textbox', { name: 'Chat with AI' }), { target: { value: '수정해 줘' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(JSON.stringify(fetch.mock.calls)).toContain('/message'));
  const request = fetch.mock.calls.find(([url]) => url.endsWith('/message'))!;
  expect(JSON.parse(request[1]!.body as string)).toEqual({ text: '대상 문서: proposal.md (버전 v1)\n수정해 줘' });
});

it('서버 오류 상세를 번역 안내로 대체하지 않는다', async () => {
  const raw = 'already has an active writer: writer=123; detail=원문';
  const work = { id: 'w', phase: 'planning', state: 'recovery-required', error: raw, documents: [], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => work })));
  render(<WorkRoom change={{ id: 'demo/c', name: 'c', sourceId: 'demo' } as Change} onClose={() => {}} />, { locale: 'en' });
  expect(await screen.findByText(raw)).toBeInTheDocument();
});

it('한국어 변경 상세의 상태와 진행률은 번역하고 문서는 보존한다', async () => {
  const change = { id: 'demo/c', name: 'feature', sourceId: 'demo', status: 'in_progress', hasProposal: true, taskStats: { total: 2, done: 1 } } as Change;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ ...change, proposal: '# Original 문서', specs: [] }) })));
  render(<DetailModal change={change} onClose={() => {}} />);
  expect(screen.getByText('진행 중')).toBeInTheDocument();
  expect(screen.getByText('2개 작업 중 1개 완료')).toBeInTheDocument();
  expect(await screen.findByText('Original 문서')).toBeInTheDocument();
});

it('변경 카드의 선행 문서 안내는 번역하고 API 상태는 보존한다', () => {
  const change = { id: 'demo/c', name: 'feature', sourceId: 'demo', status: 'todo', artifacts: [{ id: 'tasks', state: 'blocked', missingDeps: ['design'] }], taskStats: { total: 1, done: 0 } } as Change;
  const click = vi.fn();
  render(<ChangeCard change={change} onClick={() => click(change)} />);
  expect(screen.getByTitle('design 대기 중')).toBeInTheDocument();
  fireEvent.click(screen.getByText('feature'));
  expect(click).toHaveBeenCalledWith(change);
  expect(change.status).toBe('todo');
});
it('한국어 오류 안내와 원문 상세를 표시하고 재시도한다', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  let broken = true;
  function Broken() { if (broken) throw new Error('raw server detail'); return <p>복구됨</p>; }
  render(<ErrorBoundary><Broken /></ErrorBoundary>);
  expect(screen.getByText('raw server detail')).toBeInTheDocument();
  broken = false;
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(screen.getByText('복구됨')).toBeInTheDocument();
  log.mockRestore();
});
