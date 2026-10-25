import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { IdeaDetailModal } from './IdeaDetailModal';
import type { Idea } from '../types';
it('선택한 아이디어와 변경 이름으로 업무를 시작한다', async () => {
  const idea = { id: 'demo/idea-1', title: '검증 아이디어', description: '한 세션 진행', sourceId: 'demo', createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' } as Idea;
  const start = vi.fn().mockResolvedValue(undefined); render(<IdeaDetailModal idea={idea} onClose={() => {}} onStart={start} />);
  fireEvent.change(screen.getByRole('textbox', { name: '변경 이름' }), { target: { value: 'one-session' } }); fireEvent.click(screen.getByRole('button', { name: '아이디어에서 업무 시작' }));
  await waitFor(() => expect(start).toHaveBeenCalledWith(idea, 'one-session'));
});
