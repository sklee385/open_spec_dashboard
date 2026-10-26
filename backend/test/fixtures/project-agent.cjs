// Deterministic local protocol fixture: no model or remote service is contacted.
const fs = require('node:fs');
const path = require('node:path');
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'thread/start' || request.method === 'thread/resume' ? { thread: { id: 'project-thread' } } : request.method === 'turn/start' ? { turn: { id: 'project-turn', status: 'inProgress' } } : {};
  send({ id: request.id, result });
  if (request.method === 'turn/start') setTimeout(() => {
    fs.writeFileSync(path.join(request.params.cwd, 'ai-change.txt'), 'AI fixture change\n');
    send({ method: 'item/agentMessage/delta', params: { threadId: 'project-thread', turnId: 'project-turn', itemId: 'result', delta: '업무 공간에서 테스트 코드 변경을 생성했습니다.' } });
    send({ method: 'turn/completed', params: { threadId: 'project-thread', turn: { id: 'project-turn', status: 'completed' } } });
  }, 20);
});
