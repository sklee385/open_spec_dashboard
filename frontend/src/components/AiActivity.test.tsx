import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { render } from '../test/render';
import { AiActivity } from './AiActivity';

it('실행과 사용자 답변 대기를 구분한다', () => {
  const view = render(<AiActivity state="running" count={2} />);
  expect(screen.getByRole('status')).toHaveTextContent('AI 작업 중 · 2');
  view.rerender(<AiActivity state="waiting-input" />);
  expect(screen.getByRole('status')).toHaveTextContent('사용자 답변 대기');
  expect(screen.queryByText(/AI 작업 중/)).not.toBeInTheDocument();
  view.rerender(<AiActivity />);
  expect(screen.getByRole('status')).toHaveTextContent('연결 확인 필요');
});
