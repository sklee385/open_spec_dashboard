import { fireEvent, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { AttentionBell, AttentionContext, AttentionOverlays } from './AttentionCenter';
import type { AttentionState } from '../hooks/useAttention';
const items = [{ workId: 'w', sourceId: 'demo', changeName: 'feature', title: '업무 이름', questionId: 'q', kind: 'approval' as const, status: 'pending' as const, createdAt: '2026-10-25T01:00:00Z' }];
function state(): AttentionState {
  return { items, notices: items, expanded: true, setExpanded: vi.fn(), open: vi.fn(), updateWindows: vi.fn(), savingSettings: false, nativeSettings: { enabled: true, effectiveEnabled: false, dashboardUrl: 'http://localhost:13001/', registrationStatus: 'failed', lastError: 'registration-error' }, reportNavigationError: vi.fn(), dismissNotices: vi.fn(), navigating: false, connectionError: false, storageError: false, windowsError: false, navigationError: false };
}
it('프로젝트·업무·요청 종류와 대기 수를 표시하고 안내·목록이 같은 이동 함수를 쓴다', () => {
  const model = state();
  const view = render(<AttentionContext.Provider value={model}><AttentionBell /><AttentionOverlays sources={[{ id: 'demo', name: '프로젝트 이름', path: '', valid: true }]} /></AttentionContext.Provider>);
  expect(screen.getByRole('button', { name: '응답이 필요한 요청 1' })).toBeVisible();
  const panel = screen.getByRole('dialog', { name: '응답이 필요한 요청' });
  expect(within(panel).getByText('프로젝트 이름')).toBeVisible(); expect(within(panel).getByText('승인 필요')).toBeVisible();
  fireEvent.click(within(panel).getByRole('button', { name: /업무 이름/ })); expect(model.open).toHaveBeenCalledWith(items[0]);
  fireEvent.click(within(screen.getByRole('status', { name: '응답이 필요한 요청' })).getByRole('button', { name: /업무 이름/ })); expect(model.open).toHaveBeenCalledTimes(2);
  view.rerender(<AttentionContext.Provider value={{ ...model, items: [], notices: [], connectionError: true }}><AttentionBell /><AttentionOverlays sources={[]} /></AttentionContext.Provider>);
  expect(screen.getByRole('button', { name: '응답이 필요한 요청 0' })).toBeVisible();
  expect(screen.getByText('연결 확인 중입니다. 목록은 마지막으로 확인한 상태입니다.')).toBeVisible();
});
it('영어·권한 거부·저장소·표시·이동 오류를 표시하고 명시적 버튼으로만 활성화한다', () => {
  const model = { ...state(), storageError: true, windowsError: true, navigationError: true };
  render(<AttentionContext.Provider value={model}><AttentionOverlays sources={[]} /></AttentionContext.Provider>, { locale: 'en' });
  expect(screen.getByText(/Windows notifications are not active/)).toBeVisible();
  expect(screen.getByText(/Notification storage is unavailable/)).toBeVisible();
  expect(screen.getByText(/could not be confirmed/)).toBeVisible();
  expect(screen.getByText(/Could not open the request/)).toBeVisible();
  expect(model.updateWindows).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Disable Windows notifications' }));
  expect(model.updateWindows).toHaveBeenCalledWith({ enabled: false });
});
