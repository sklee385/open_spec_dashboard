const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const op = process.argv[2];
if (process.argv.length !== 3 || !['run', 'status', 'cancel'].includes(op)) { console.error('사용법: node cli.cjs run|status|cancel'); process.exit(1); }
const id = randomUUID(), request = path.join(__dirname, 'requests', `${id}.json`), response = path.join(__dirname, 'results', `${id}.json`);
fs.writeFileSync(request + '.tmp', JSON.stringify({ id, op }), { flag: 'wx' }); fs.renameSync(request + '.tmp', request);
const deadline = Date.now() + (op === 'run' ? 140000 : 15000);
const timer = setInterval(() => {
  if (fs.existsSync(response)) {
    clearInterval(timer); const result = JSON.parse(fs.readFileSync(response, 'utf8')); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.success ? 0 : 1;
  } else if (Date.now() > deadline) { clearInterval(timer); console.error('OpenSpecBoard 응답을 확인하지 못했습니다. 실행·입력을 자동 반복하지 말고 업무 화면에서 결과를 확인해 주세요.'); process.exitCode = 1; }
}, 200);
