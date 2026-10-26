import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { Header } from './Header';
import { SourceManagementModal } from './SourceManagementModal';

afterEach(() => vi.unstubAllGlobals());
function Navigation({ emptyBoard = false }: { emptyBoard?: boolean }) {
  const [open, setOpen] = useState(false);
  const [empty, setEmpty] = useState(emptyBoard);
  const focus = useRef<HTMLElement | null>(null);
  return <><Header currentView="kanban" onViewChange={() => {}} sources={[]} selectedSourceId={null} onSourceChange={() => {}} onOpenSources={trigger => { focus.current = trigger; setOpen(true); }} />{empty && <button onClick={event => { focus.current = event.currentTarget; setOpen(true); }}>첫 소스 등록</button>}<SourceManagementModal open={open} onOpenChange={setOpen} returnFocusRef={focus} onSaved={() => setEmpty(false)} /></>;
}

it('헤더에서 독립 창을 열고 Escape로 닫으면 진입점에 초점을 복원한다', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '{"sources":[]}' })));
  render(<Navigation />);
  const trigger = screen.getByRole('button', { name: '소스 관리 열기' });
  trigger.focus(); fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: '소스 관리' });
  await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '소스 관리' })).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
});

it('첫 소스 등록 후 빈 보드 진입점이 없어지면 헤더 진입점으로 초점을 복원한다', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, text: async () => '{"sources":[]}' }).mockResolvedValueOnce({ ok: true, text: async () => '{"sources":[{"name":"demo","path":"/demo"}]}' }));
  render(<Navigation emptyBoard />);
  fireEvent.click(screen.getByText('첫 소스 등록'));
  await waitFor(() => expect(screen.getByLabelText('이름')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('이름'), { target: { value: 'demo' } });
  fireEvent.change(screen.getByLabelText('경로'), { target: { value: '/demo' } });
  fireEvent.click(screen.getByRole('button', { name: '소스 추가' }));
  await screen.findByText('demo');
  fireEvent.click(screen.getByRole('button', { name: '닫기' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '소스 관리 열기' })).toHaveFocus());
});

it('모바일 메뉴를 닫고 소스 창을 열며 닫은 뒤 메뉴 버튼에 초점을 돌린다', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '{"sources":[]}' })));
  render(<Navigation />);
  const menu = screen.getByRole('button', { name: '메뉴 열기' });
  fireEvent.click(menu);
  const sheet = screen.getByRole('dialog');
  fireEvent.click(within(sheet).getByRole('button', { name: '소스 관리 열기' }));
  const dialog = await screen.findByRole('dialog', { name: '소스 관리' });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
  await waitFor(() => expect(menu).toHaveFocus());
});
