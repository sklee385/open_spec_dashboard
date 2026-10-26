import { fireEvent, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { render } from '../test/render';
import { FileDiff } from './FileDiff';

it('수정된 줄을 추가·삭제와 원본 줄 번호로 표시한다', () => {
  render(<FileDiff path="app.ts" before={'keep\nconst a = 1;\nend\n'} after={'keep\nconst a = 2;\nend\n'} />);
  expect(screen.getByText('const a = 1;').closest('tr')).toHaveAttribute('data-change', 'removed');
  expect(screen.getByText('const a = 2;').closest('tr')).toHaveAttribute('data-change', 'added');
  expect(screen.getByText('1줄 추가 · 1줄 삭제')).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: '변경 전 줄' })).toBeInTheDocument();
});
it('변경 없는 긴 구간을 접고 사용자가 펼칠 수 있다', () => {
  const lines = Array.from({ length: 40 }, (_, n) => `line ${n + 1}`);
  render(<FileDiff path="app.ts" before={lines.join('\n')} after={lines.map((s, n) => n === 20 ? 'changed' : s).join('\n')} />);
  expect(screen.queryByText('line 10')).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: /변경 없는 .*줄 펼치기/ })[0]);
  expect(screen.getByText('line 10')).toBeInTheDocument();
  expect(screen.getByText('line 20')).toBeInTheDocument();
});
it('새 파일과 삭제 파일은 각각 모든 줄을 추가·삭제로 표시한다', () => {
  const { unmount } = render(<FileDiff path="new.ts" before={null} after={'one\ntwo\n'} />);
  expect(screen.getByText('2줄 추가 · 0줄 삭제')).toBeInTheDocument(); unmount();
  render(<FileDiff path="old.ts" before={'old\n'} after={null} />);
  expect(screen.getByText('0줄 추가 · 1줄 삭제')).toBeInTheDocument();
});
it('텍스트가 없는 파일과 마지막 줄 개행의 차이를 구분한다', () => {
  const { unmount } = render(<FileDiff path="image.png" before={null} after={null} />);
  expect(screen.getByText('텍스트 내용을 비교할 수 없는 파일입니다.')).toBeInTheDocument(); unmount();
  render(<FileDiff path="text.txt" before={'last\n'} after="last" />);
  expect(screen.getByText('줄 끝 개행 없음')).toBeInTheDocument();
});
it('한쪽 내용이 미수집이면 빈 파일로 오인해 추가 줄을 표시하지 않는다', () => {
  render(<FileDiff path="data.bin" before={null} after="text" beforeAvailability="binary" afterAvailability="text" />);
  expect(screen.queryByText('1줄 추가 · 0줄 삭제')).not.toBeInTheDocument();
  expect(screen.getByText(/바이너리 파일/)).toBeInTheDocument();
});
it('실제 빈 파일은 비교할 수 있으며 크기 제한과 구분한다', () => {
  render(<FileDiff path="empty.txt" before={null} after="" beforeAvailability="absent" afterAvailability="text" />);
  expect(screen.getByText('표시할 텍스트 줄 변경이 없습니다.')).toBeInTheDocument();
});
