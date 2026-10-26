const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function verifyStartupRecovery({ nodeBinary, service, environment, directory, runtimeArgs }) {
  const profile = path.join(directory, 'failed-start-profile');
  fs.mkdirSync(profile);
  const data = path.join(profile, 'data');
  fs.writeFileSync(data, 'intentional startup failure fixture');
  const env = { ...environment, DATA_DIR: data, CONFIG_PATH: path.join(profile, 'config.json') };
  const launch = () => {
    const child = spawn(nodeBinary, [...runtimeArgs, path.join(service, 'backend/dist/desktop-main.js')], { cwd: profile, env, windowsHide: true, stdio: ['ignore','ignore','pipe','ipc'] });
    child.stderr.resume(); return child;
  };
  let child = launch();
  try {
    await new Promise((resolve, reject) => {
      let failed = false;
      const timer = setTimeout(() => reject(new Error('실패 서비스 종료 시간 초과')), 10000);
      child.on('message', message => { if (message.type === 'startup-error') failed = true; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); failed && code === 1 ? resolve() : reject(new Error('서비스 시작 실패가 명시되지 않았습니다')); });
    });
    assert.equal(fs.readFileSync(data, 'utf8'), 'intentional startup failure fixture');
    fs.unlinkSync(data); fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'notifications.json'), JSON.stringify({ enabled: false, dashboardUrl: 'http://127.0.0.1:13001/' }));
    child = launch();
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('복구 서비스 준비 시간 초과')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`복구 서비스 시작 실패 ${code}`)); });
      child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message.port); } });
    });
    const prepared = await fetch(`http://127.0.0.1:${port}/api/desktop/prepare`, { method: 'POST', headers: { 'x-desktop-token': environment.DESKTOP_TOKEN }, signal: AbortSignal.timeout(5000) });
    assert.equal(prepared.status, 201);
    await new Promise((resolve, reject) => {
      let stopped = false;
      const timer = setTimeout(() => reject(new Error('복구 서비스 정상 종료 시간 초과')), 10000);
      child.on('message', message => { if (message.type === 'stopped') stopped = true; });
      child.once('exit', code => { clearTimeout(timer); stopped && code === 0 ? resolve() : reject(new Error('복구 서비스 백업 종료 실패')); });
      child.send({ type: 'shutdown' });
    });
    assert.ok(fs.readdirSync(path.join(profile, 'backups')).length);
    console.log('별도 프로필의 실제 시작 실패·원본 보존·동일 경로 복구·정상 종료·백업 통과');
  } finally { if (child.exitCode === null) child.kill(); }
}
module.exports = { verifyStartupRecovery };
