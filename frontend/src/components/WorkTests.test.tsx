import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { WorkTestActions, WorkTestResults } from './WorkTests';

afterEach(cleanup);
const commands = [{ id: 'test', command: 'npm', args: ['test'] }];
it('작업 테스트와 전체 테스트를 각각 요청하고 실행 중에는 중복 시작하지 않는다', () => {
  const onRun = vi.fn();
  const view = render(<WorkTestActions disabled={false} onRun={onRun} />);
  fireEvent.click(screen.getByRole('button', { name: '작업 테스트' }));
  fireEvent.click(screen.getByRole('button', { name: '전체 테스트' }));
  expect(onRun.mock.calls).toEqual([['work'], ['full']]);
  view.rerender(<WorkTestActions disabled onRun={onRun} />);
  expect(screen.getByRole('button', { name: '작업 테스트' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '전체 테스트' })).toBeDisabled();
});
it('작업 통과를 전체 통과로 표시하지 않고 과거 결과는 재검증 필요로 표시한다', () => {
  render(<WorkTestResults workCommands={commands} fullCommands={commands} results={[{ id: 'w', commandId: 'test', scope: 'work', status: 'passed', fresh: true, stdout: '', stderr: '', code: 0 }, { id: 'f', commandId: 'test', scope: 'full', status: 'passed', fresh: false, stdout: '', stderr: '', code: 0 }]} onFix={() => {}} />);
  expect(screen.getByRole('heading', { name: '작업 테스트 · 통과' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '전체 테스트 · 재검증 필요' })).toBeInTheDocument();
});
it('실패 로그와 소요 시간을 표시하고 수정 요청을 준비한다', () => {
  const onFix = vi.fn();
  render(<WorkTestResults workCommands={[]} fullCommands={commands} results={[{ id: 'f', commandId: 'test', scope: 'full', status: 'failed', fresh: true, stdout: '', stderr: 'broken', code: 1, durationMs: 1200 }]} onFix={onFix} />);
  expect(screen.getByText(/broken/)).toBeInTheDocument();
  expect(screen.getByText(/1.2초/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '실패 결과로 수정 요청' }));
  expect(onFix).toHaveBeenCalledWith(expect.stringContaining('broken'));
  expect(screen.getByRole('heading', { name: '작업 테스트 · 미검증' })).toBeInTheDocument();
});
