const readline = require('node:readline');
const fs = require('node:fs');
let turnActive = false;
const send = value => { if (value.method === 'turn/completed') turnActive = false; process.stdout.write(JSON.stringify(value) + '\n'); };
let turnTimer;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (process.env.CODEX_TEST_LOG) fs.appendFileSync(process.env.CODEX_TEST_LOG, line + '\n');
  if (!msg.method) { if (msg.id === 999 && process.env.CODEX_TEST_DOC) fs.writeFileSync(process.env.CODEX_TEST_DOC, '# 답변 반영\n' + JSON.stringify(msg.result)); send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }); return; }
  if (msg.id === undefined) return;
  if (msg.method === 'turn/start' && process.env.CODEX_TEST_MODE === 'turn-rejected') { send({ id: msg.id, error: { code: -32600, message: '명시적 턴 시작 거절' } }); return; }
  if (msg.method === 'thread/resume' && process.env.CODEX_TEST_MODE === 'missing-rollout' && !msg.params.path) { send({ id: msg.id, error: { code: -32600, message: 'no rollout found for thread id thread-1' } }); return; }
  if (msg.method === 'thread/resume' && process.env.CODEX_TEST_MODE === 'writer-conflict') { send({ id: msg.id, error: { code: -32600, message: 'thread thread-1 already has an active writer' } }); return; }
  if (msg.method === 'test/error' || (msg.method === 'thread/resume' && process.env.CODEX_TEST_MODE === 'resume-error')) { send({ id: msg.id, error: { code: -32603, message: '복원 실패 테스트' } }); return; }
  if (msg.method === 'test/exit' || (msg.method === 'thread/start' && process.env.CODEX_TEST_MODE === 'lost-start')) { process.exit(3); }
  let result = {};
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') result = { thread: { id: 'thread-1' } };
  if (msg.method === 'thread/read') result = { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: turnActive ? 'inProgress' : 'completed' }] } };
  if (msg.method === 'account/read') result = { account: { type: 'chatgpt' }, requiresOpenaiAuth: false };
  if (msg.method === 'turn/start') { turnActive = true; result = { turn: { id: 'turn-1', status: 'inProgress' } }; }
  send({ id: msg.id, result });
  if (msg.method === 'turn/start' && process.env.CODEX_TEST_MODE === 'turn-hold') return;
  if (msg.method === 'turn/interrupt') { clearTimeout(turnTimer); setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } }), 50); }
  if (msg.method === 'turn/start') turnTimer = setTimeout(() => {
    const text = JSON.stringify(msg.params.input);
    if (text.includes('구조화 질문')) send({ id: 998, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'ask_user', arguments: { questions: [{ id: 'filename', question: '파일 이름은?', options: [] }] } } });
    else if (text.includes('질문 해줘')) send({ id: 999, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', isBlocking: true, questions: [{ id: 'choice', header: '정책', question: '어떤 방식인가요?', options: null }] } });
    else if (text.includes('질문 도구 종료')) {
      send({ id: 997, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'expired-call', tool: 'ask_user', arguments: { questions: [{ id: 'choice', question: '어떤 방식인가요?', options: [] }] } } });
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'expired-call', type: 'dynamicToolCall', status: 'failed', success: false } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    }
    else if (text.includes('앱 접근 승인')) send({ id: 1001, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-1', turnId: 'turn-1', serverName: 'apps', mode: 'form', message: 'Allow Codex to use electron?', requestedSchema: { type: 'object', properties: {} } } });
    else if (text.includes('승인 해줘')) send({ id: 1000, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', command: 'npm test', cwd: process.cwd(), reason: '테스트 실행' } });
    else {
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: '같은 대화에서 답변합니다.' } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    }
  }, JSON.stringify(msg.params.input).includes('지연') ? 200 : 20);
});
