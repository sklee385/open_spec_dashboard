import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { Header } from './Header';
import { AiToolSettings } from './AiToolSettings';
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});
const sources = [{ id: 'one', name: 'Synthetic one', path: '/fixture/one', valid: true }, { id: 'two', name: 'Synthetic two', path: '/fixture/two', valid: true }];
it('preserves the open project picker and focused option across activity and source refreshes', async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const selected = vi.fn(), props = { currentView: 'kanban' as const, sources, selectedSourceId: null, onSourceChange: selected, onViewChange: vi.fn() };
  const view = render(<Header {...props} />), trigger = screen.getByRole('combobox');
  fireEvent.keyDown(trigger, { key: 'ArrowDown' }); await screen.findByRole('listbox');
  const focused = document.activeElement;
  await act(async () => view.rerender(<Header {...props} aiState="running" sources={sources.map(source => ({ ...source }))} />));
  // Radix hides the background trigger from accessibility while its popup is open.
  expect(screen.getByRole('combobox', { hidden: true })).toBe(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('listbox')).toBeVisible();
  expect(document.activeElement).toBe(focused); expect(selected).not.toHaveBeenCalled();
});
it('retains the chosen project when a refreshed source list arrives and changes only on user selection', async () => {
  const selected = vi.fn(), props = { currentView: 'kanban' as const, sources, selectedSourceId: 'one', onSourceChange: selected, onViewChange: vi.fn() };
  const view = render(<Header {...props} />), trigger = screen.getByRole('combobox'); trigger.focus();
  await act(async () => view.rerender(<Header {...props} aiState="idle" sources={[...sources]} />));
  expect(screen.getByRole('combobox')).toBe(trigger); expect(trigger).toHaveFocus(); expect(trigger).toHaveTextContent('Synthetic one'); expect(selected).not.toHaveBeenCalled();
});
it('does not reload settings or overwrite an edited settings draft and its focus during header updates', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ version: 'v1', defaultToolId: 'codex', tools: [{ id: 'codex', name: 'Codex', kind: 'codex' }, { id: 'external', name: 'Synthetic tool', kind: 'external-cli', executable: 'fixture', args: [], input: 'stdin', timeoutMs: 1000 }] }) }));
  vi.stubGlobal('fetch', fetcher);
  const props = { currentView: 'kanban' as const, sources, selectedSourceId: null, onSourceChange: vi.fn(), onViewChange: vi.fn() };
  const view = render(<><Header {...props} /><AiToolSettings /></>);
  const editor = await screen.findByRole('textbox', { name: '도구 이름' });
  editor.focus(); fireEvent.change(editor, { target: { value: 'Unsaved synthetic name' } });
  await act(async () => view.rerender(<><Header {...props} aiState="running" sources={sources.map(s => ({ ...s }))} /><AiToolSettings /></>));
  expect(screen.getByRole('textbox', { name: '도구 이름' })).toBe(editor); expect(editor).toHaveValue('Unsaved synthetic name'); expect(editor).toHaveFocus();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
