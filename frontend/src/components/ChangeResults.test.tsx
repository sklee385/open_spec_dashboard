import { fireEvent, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { ChangeResults } from './ChangeResults';
it('완료 당시 시각·업무와 변경 없음 및 과거 기록 없음을 구분한다', () => {
  const { unmount } = render(<ChangeResults workId="A" files={[]} report={{ source: 'completed', startedAt: 'start', endedAt: 'end', isolated: true, application: 'applied' }} />);
  expect(screen.getByText(/완료 당시 변경/)).toBeInTheDocument(); expect(screen.getByText(/A/)).toBeInTheDocument();
  expect(screen.getByText('변경된 파일이 없습니다.')).toBeInTheDocument(); unmount();
  render(<ChangeResults workId="B" files={[]} report={{ source: 'unavailable' }} />);
  expect(screen.getByText(/업무별 변경 기록이 없습니다/)).toBeInTheDocument(); expect(screen.queryByText('변경된 파일이 없습니다.')).not.toBeInTheDocument();
});
it('현재 결과에서 별도 원본 반영 요청과 충돌 상태를 표시한다', () => {
  const apply = vi.fn();
  render(<ChangeResults workId="A" files={[]} onApply={apply} report={{ source: 'current', application: 'conflict' }} />);
  expect(screen.getByText(/원본 반영 충돌/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '원본에 반영' })); expect(apply).toHaveBeenCalledOnce();
});
it('과거 업무의 전환은 별도 요청이며 전환 이전 변경을 복원하지 않는다', () => {
  const isolate = vi.fn();
  render(<ChangeResults workId="A" files={[]} onIsolate={isolate} report={{ source: 'unavailable' }} />);
  expect(screen.getByText(/전환 시점부터/)).toBeInTheDocument(); expect(isolate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '업무 전용 공간으로 전환' })); expect(isolate).toHaveBeenCalledOnce();
});
