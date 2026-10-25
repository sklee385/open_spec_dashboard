import { render as renderLocalized } from '../test/render';
const render: typeof renderLocalized = (view, options) => renderLocalized(view, { locale: 'en', ...options });
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { KanbanBoard } from './KanbanBoard';
import type { Change, Idea, Source } from '../types';
import { useIsMobile } from '../hooks/useMediaQuery';
vi.mock('../hooks/useMediaQuery', () => ({ useIsMobile: vi.fn(() => false) }));
beforeEach(() => vi.mocked(useIsMobile).mockReturnValue(false));

describe('KanbanBoard', () => {
  const mockChanges: Change[] = [
    {
      id: '1',
      name: 'Test Change',
      sourceId: 'test-source',
      status: 'todo',
      taskStats: { done: 0, total: 5 },
      hasProposal: true,
      hasSpecs: true,
      hasTasks: true,
      hasDesign: false,
      schema: 'spec-driven',
      artifacts: [
        { id: 'proposal', state: 'complete', missingDeps: [] },
        { id: 'design', state: 'ready', missingDeps: [] },
        { id: 'specs', state: 'complete', missingDeps: [] },
        { id: 'tasks', state: 'complete', missingDeps: [] },
      ],
    },
  ];

  const mockIdeas: Idea[] = [
    {
      id: '1',
      title: 'Test Idea',
      description: 'Test description',
      sourceId: 'test-source',
      projectId: 'test-project',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const mockSources: Source[] = [
    {
      id: 'test-source',
      name: 'Test Source',
      path: '/test/path',
      valid: true,
    },
  ];

  it('renders without crashing', () => {
    const { container } = render(
      <KanbanBoard
        changes={mockChanges}
        ideas={mockIdeas}
        sources={mockSources}
        onCardClick={vi.fn()}
        onIdeaClick={vi.fn()}
        selectedSourceId={null}
      />
    );
    expect(container).toBeInTheDocument();
  });

  it('displays loading state when loading is true', () => {
    render(
      <KanbanBoard
        changes={[]}
        ideas={[]}
        sources={mockSources}
        loading={true}
        onCardClick={vi.fn()}
        onIdeaClick={vi.fn()}
        selectedSourceId={null}
      />
    );
    // Should render skeleton loaders (uses animate-shimmer class)
    const skeletons = document.querySelectorAll('.before\\:animate-shimmer');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('displays error state when error is provided', () => {
    const error = new Error('Test error');
    render(
      <KanbanBoard
        changes={[]}
        ideas={[]}
        sources={mockSources}
        error={error}
        onCardClick={vi.fn()}
        onIdeaClick={vi.fn()}
        selectedSourceId={null}
      />
    );
    expect(screen.getByText('Error loading changes')).toBeInTheDocument();
  });

  it('displays empty state when no items', () => {
    render(
      <KanbanBoard
        changes={[]}
        ideas={[]}
        sources={[]}
        onCardClick={vi.fn()}
        onIdeaClick={vi.fn()}
        selectedSourceId={null}
      />
    );
    expect(screen.getByText('No OpenSpec sources configured')).toBeInTheDocument();
  });
  it('아이디어가 업무로 전환된 후 모든 단계에서 같은 카드에 접근한다', () => {
    const click = vi.fn(), props = { sources: mockSources, onCardClick: click, selectedSourceId: null, showArchived: true };
    const { rerender } = render(<KanbanBoard {...props} ideas={[{ ...mockIdeas[0], title: '다국어처리' }]} changes={[]} />);
    expect(screen.getByRole('heading', { name: '다국어처리' })).toBeInTheDocument();
    for (const status of ['draft', 'todo', 'in_progress', 'done', 'archived'] as const) {
      const change = { ...mockChanges[0], id: 'source/idea-123', name: 'idea-123', title: '다국어처리', status, taskStats: status === 'draft' ? null : { total: 1, done: status === 'done' || status === 'archived' ? 1 : 0 } } as Change;
      rerender(<KanbanBoard {...props} ideas={[]} changes={[change]} />);
      const card = screen.getByRole('heading', { name: '다국어처리' }); fireEvent.click(card); expect(click).toHaveBeenLastCalledWith(change);
    }
  });
  it('자동 생성된 변경 이름 대신 원본 아이디어 제목으로 초안을 검색한다', () => {
    const change = { ...mockChanges[0], name: 'idea-123', title: '다국어처리', status: 'draft', taskStats: null } as Change;
    render(<KanbanBoard sources={mockSources} onCardClick={vi.fn()} selectedSourceId={null} ideas={[]} changes={[change]} />);
    fireEvent.change(screen.getByPlaceholderText('Search changes...'), { target: { value: '다국어' } });
    expect(screen.getByRole('heading', { name: '다국어처리' })).toBeInTheDocument();
  });
  it('좁은 화면에서도 초안 탭으로 전환한 업무에 접근한다', () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    const change = { ...mockChanges[0], name: 'idea-123', title: '다국어처리', status: 'draft', taskStats: null } as Change;
    render(<KanbanBoard sources={mockSources} onCardClick={vi.fn()} selectedSourceId={null} ideas={[]} changes={[change]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Draft (1)' }));
    expect(screen.getByRole('heading', { name: '다국어처리' })).toBeInTheDocument();
  });
});
