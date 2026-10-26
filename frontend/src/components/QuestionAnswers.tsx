import { useI18n } from '@/i18n/context';

type QuestionText = { id: string; question: string };
type Answers = Record<string, { answers: string[] }>;
const prefix = '연결 종료로 만료된 확인 질문의 사용자 답변을 같은 대화에 복구한다. 질문: ';

/** Recognize only the internal recovery envelope; ordinary user JSON stays unchanged. */
export function recoveredAnswer(text: string): { questions: QuestionText[]; answers: Answers; instructions: string } | null {
  if (!text.startsWith(prefix)) return null;
  const boundary = text.indexOf('\n답변: ', prefix.length);
  if (boundary < 0) return null;
  const answerStart = boundary + '\n답변: '.length;
  const end = text.indexOf('\n', answerStart);
  try {
    const questions = JSON.parse(text.slice(prefix.length, boundary));
    const answers = JSON.parse(text.slice(answerStart, end < 0 ? undefined : end));
    if (!Array.isArray(questions) || !questions.length || questions.some(q => typeof q?.id !== 'string' || typeof q?.question !== 'string')) return null;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers) || questions.some(q => !Object.hasOwn(answers, q.id) || !Array.isArray(answers[q.id]?.answers) || answers[q.id].answers.some((answer: unknown) => typeof answer !== 'string'))) return null;
    return { questions, answers, instructions: end < 0 ? '' : text.slice(end + 1) };
  } catch { return null; }
}

export function QuestionAnswers({ questions, answers }: { questions: QuestionText[]; answers: unknown }) {
  const { t } = useI18n();
  return <div className="work-answer-summary">{questions.map((question, index) => {
    const value = answers && typeof answers === 'object' && Object.hasOwn(answers, question.id) ? (answers as Record<string, unknown>)[question.id] : undefined;
    const list = value && typeof value === 'object' && 'answers' in value && Array.isArray(value.answers) ? value.answers.filter((answer): answer is string => typeof answer === 'string') : [];
    return <div key={`${question.id}:${index}`} className="work-answer-item">
      <p className="work-answer-label">{t('answers.question')}</p><p>{question.question}</p>
      <p className="work-answer-label">{t('answers.answer')}</p>
      {list.length ? list.map((answer, index) => <p className="work-answer-value" key={index}>{answer || t('answers.empty')}</p>) : <p>{t('answers.empty')}</p>}
    </div>;
  })}</div>;
}

export function RecoveredAnswer({ text }: { text: string }) {
  const { t } = useI18n();
  const recovered = recoveredAnswer(text);
  if (!recovered) return null;
  return <div>
    <p className="work-answer-heading">{t('answers.restored')}</p>
    <QuestionAnswers questions={recovered.questions} answers={recovered.answers} />
    {recovered.instructions && <details className="work-event"><summary>{t('answers.instructions')}</summary><p>{recovered.instructions}</p></details>}
  </div>;
}
