const fs = require('node:fs');
const { spawn } = require('node:child_process');
const mode = process.argv[2] || 'echo';
if (mode === 'tree') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(process.argv[3], String(child.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'slow') setTimeout(() => console.log('완료'), 60000);
else if (mode === 'overflow') process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));
else if (mode === 'fail') { console.error('authentication failed token=PRIVATE_SECRET'); process.exitCode = 7; }
else if (mode === 'argument') console.log(process.argv[3]);
else {
  let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => { if (process.argv[3]) fs.writeFileSync(process.argv[3], input); console.log(input); });
}
