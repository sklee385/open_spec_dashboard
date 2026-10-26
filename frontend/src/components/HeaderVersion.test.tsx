import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { I18nProvider } from '../i18n/provider';
import { Header } from './Header';
import product from '../../../package.json';

afterEach(cleanup);

it('메뉴를 열지 않아도 모든 화면의 로고 옆에 제품 버전을 유지한다', () => {
  const props = { currentView: 'kanban' as const, onViewChange: vi.fn(), sources: [], selectedSourceId: null, onSourceChange: vi.fn() };
  const view = render(<Header {...props} />);
  for (const currentView of ['kanban', 'specs', 'project'] as const) {
    view.rerender(<I18nProvider locale="ko"><Header {...props} currentView={currentView} /></I18nProvider>);
    const header = screen.getByRole('banner');
    const version = within(header).getByLabelText('앱 버전');
    expect(version).toBeVisible();
    expect(version).toHaveTextContent(`v${product.version}`);
    expect(version.parentElement).toContainElement(within(header).getByText('OpenSpecBoard'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }
});
