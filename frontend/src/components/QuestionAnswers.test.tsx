import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { render } from '../test/render';
import { RecoveredAnswer, recoveredAnswer } from './QuestionAnswers';

const questions = [{ id: 'scope', question: '어떤 변경을 표시할까요?', options: [{ label: '이 업무만', description: '업무 격리' }] }, { id: 'note', question: '추가 의견이 있나요?' }];
const answers = { scope: { answers: ['이 업무만'] }, note: { answers: ['줄바꿈\n설명과 "따옴표", 답변: 문구도 유지'] } };
const message = `연결 종료로 만료된 확인 질문의 사용자 답변을 같은 대화에 복구한다. 질문: ${JSON.stringify(questions)}\n답변: ${JSON.stringify(answers)}\n결정을 문서에 반영한다.`;

it('기존 복구 기록을 질문·답변으로 표시하고 JSON 필드는 노출하지 않는다', () => {
  render(<RecoveredAnswer text={message} />);
  expect(screen.getByText('어떤 변경을 표시할까요?')).toBeVisible();
  expect(screen.getByText('이 업무만')).toBeVisible();
  expect(screen.getByText(/줄바꿈/)).toHaveTextContent('따옴표');
  expect(screen.queryByText(/"scope"|"answers"|"options"/)).not.toBeInTheDocument();
  expect(screen.getByText('결정을 문서에 반영한다.')).not.toBeVisible();
});
it('일반 사용자 JSON과 형식이 잘못된 복구 기록은 원문 표시 대상으로 남긴다', () => {
  expect(recoveredAnswer(JSON.stringify(answers))).toBeNull();
  expect(recoveredAnswer(message.replace('"answers":["이 업무만"]', '"answers":[17]'))).toBeNull();
  expect(recoveredAnswer(message.replace('질문: [', '질문: broken['))).toBeNull();
});
it('영어 UI에서도 사용자 질문과 답변은 원문을 유지한다', () => {
  render(<RecoveredAnswer text={message} />, { locale: 'en' });
  expect(screen.getAllByText('Your answer')).toHaveLength(2);
  expect(screen.getByText('이 업무만')).toBeVisible();
});
