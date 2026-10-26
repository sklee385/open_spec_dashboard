import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { IdeaCapture } from './IdeaCapture';
import { createIdea, updateIdea } from '../hooks/useApi';
import type { Idea } from '../types';

vi.mock('../hooks/useApi', () => ({
  useSources: () => ({ sources: [{ id: 'one', name: '첫 프로젝트' }, { id: 'two', name: '둘째 프로젝트' }] }),
  createIdea: vi.fn().mockResolvedValue({}), updateIdea: vi.fn().mockResolvedValue({}),
}));
afterEach(() => vi.clearAllMocks());

it('현재 선택한 프로젝트로 새 아이디어를 등록한다', async () => {
  render(<IdeaCapture open defaultSourceId="two" />);
  expect(screen.getByRole('combobox')).toHaveTextContent('둘째 프로젝트');
  fireEvent.change(screen.getByLabelText(/제목/), { target: { value: '새 아이디어' } });
  fireEvent.submit(screen.getByLabelText(/제목/).closest('form')!);
  await waitFor(() => expect(createIdea).toHaveBeenCalledWith('새 아이디어', '', 'two'));
});
it('다시 열면 이전 선택 대신 현재 보드 프로젝트를 기본으로 적용한다', () => {
  const view = render(<IdeaCapture open defaultSourceId="one" />);
  expect(screen.getByRole('combobox')).toHaveTextContent('첫 프로젝트');
  view.rerender(<IdeaCapture open={false} defaultSourceId="one" />);
  view.rerender(<IdeaCapture open defaultSourceId="two" />);
  expect(screen.getByRole('combobox')).toHaveTextContent('둘째 프로젝트');
});
it('전체 프로젝트 보기에서는 특정 프로젝트를 임의 선택하지 않는다', () => {
  render(<IdeaCapture open defaultSourceId={null} />);
  expect(screen.getByRole('combobox')).not.toHaveTextContent('첫 프로젝트');
  expect(screen.getByRole('combobox')).not.toHaveTextContent('둘째 프로젝트');
});
it('기존 아이디어 수정은 원래 프로젝트를 유지한다', async () => {
  render(<IdeaCapture open defaultSourceId="two" idea={{ id: 'one/idea', sourceId: 'one', title: '기존 아이디어', description: '설명' } as Idea} />);
  fireEvent.submit(screen.getByLabelText(/제목/).closest('form')!);
  await waitFor(() => expect(updateIdea).toHaveBeenCalledWith('one/idea', '기존 아이디어', '설명'));
  expect(createIdea).not.toHaveBeenCalled();
});
