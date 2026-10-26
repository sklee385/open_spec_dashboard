import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { BoardTrashContext, DeleteBoardItem, TrashControls } from './BoardTrash';

afterEach(() => vi.restoreAllMocks());
const value = (update = vi.fn().mockResolvedValue(true)) => ({ entries: [{ id: 'demo/draft', kind: 'change' as const, title: '작성하던 초안', deletedAt: '2026-10-25' }], ready: true, busy: false, error: '', update });

it('삭제 클릭은 업무를 열지 않고 취소하면 삭제하지 않는다', () => {
  const update = vi.fn(); const open = vi.fn();
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<BoardTrashContext.Provider value={value(update)}><div onClick={open}><DeleteBoardItem id="demo/draft" kind="change" /></div></BoardTrashContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: '휴지통으로 삭제' }));
  expect(update).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});
it('삭제 성공 후 닫기 콜백을 호출한다', async () => {
  const update = vi.fn().mockResolvedValue(true); const close = vi.fn();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<BoardTrashContext.Provider value={value(update)}><DeleteBoardItem id="demo/draft" kind="change" onDeleted={close} /></BoardTrashContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: '휴지통으로 삭제' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(update).toHaveBeenCalledWith({ id: 'demo/draft', kind: 'change' });
});
it('실행 중에는 삭제를 비활성화한다', () => {
  render(<BoardTrashContext.Provider value={value()}><DeleteBoardItem id="demo/draft" kind="change" state="running" /></BoardTrashContext.Provider>);
  expect(screen.getByRole('button', { name: '휴지통으로 삭제' })).toBeDisabled();
});
it('휴지통에서 원래 항목 식별자로 복원한다', () => {
  const trash = value();
  render(<BoardTrashContext.Provider value={trash}><TrashControls /></BoardTrashContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: /휴지통/ }));
  expect(screen.getByRole('dialog')).toHaveTextContent('작성하던 초안');
  fireEvent.click(screen.getByRole('button', { name: '복원' }));
  expect(trash.update).toHaveBeenCalledWith(trash.entries[0], true);
});
