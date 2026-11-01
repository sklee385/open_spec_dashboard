import { expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../test/render';
import { QueuedMessageNotice, type QueuedMessage } from './QueuedMessageNotice';

const message: QueuedMessage = { id: 'request-a', text: 'tasks.md (버전 a) 구현 전 확인', status: 'blocked', error: '문서 검토 필요' };
it('collapses only the notice, survives identical polling, and can be reopened without changing drafts or sending requests', () => {
  const fetcher = vi.spyOn(window, 'fetch');
  localStorage.setItem('work-chat-draft:w', 'keep input');
  const original = JSON.stringify(message);
  const view = render(<QueuedMessageNotice message={message} />);
  fireEvent.click(screen.getByRole('button', { name: '안내 닫기' }));
  expect(screen.queryByText(message.text, { exact: false })).toBeNull();
  view.rerender(<QueuedMessageNotice message={{ ...message }} />);
  expect(screen.getByRole('button', { name: '안내 다시 보기' })).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByRole('button', { name: '안내 다시 보기' }));
  expect(screen.getByText(message.text, { exact: false })).toBeVisible();
  expect(JSON.stringify(message)).toBe(original); expect(localStorage.getItem('work-chat-draft:w')).toBe('keep input');
  expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
});
it.each([{ text: 'tasks.md (버전 b) 구현 전 확인' }, { id: 'request-b' }, { status: 'uncertain' }, { error: '새 확인 필요' }])('shows changed request metadata again: %j', change => {
  const view = render(<QueuedMessageNotice message={message} />);
  fireEvent.click(screen.getByRole('button', { name: '안내 닫기' }));
  view.rerender(<QueuedMessageNotice message={{ ...message, ...change }} />);
  expect(screen.getByRole('button', { name: '안내 닫기' })).toHaveAttribute('aria-expanded', 'true');
});
