export const askUserTool = {
  type: 'function', name: 'ask_user',
  description: '사용자 결정이 필요한 요구사항을 한국어로 질문한다. 모든 개발 단계에서 사용 가능하며 답변을 기다린 뒤 같은 업무를 계속한다.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['questions'], properties: {
    questions: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['id', 'question', 'options'], properties: {
      id: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'description'], properties: { label: { type: 'string' }, description: { type: 'string' } } } },
    } } },
  } },
};
export const unresolvedQuestion = (q: any) => ['pending', 'sending', 'uncertain', 'recovering'].includes(q.status) || (q.kind === 'input' && q.status === 'expired');
