const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
if (process.argv.includes('--download-pipeline') && !process.argv.includes('--busy-sessions')) throw new Error('--download-pipeline에는 --busy-sessions가 필요합니다');
if (process.argv.includes('--update-backup-failure') && !process.argv.includes('--download-pipeline')) throw new Error('--update-backup-failure에는 --download-pipeline이 필요합니다');
let service = process.argv.includes('--packaged') ? path.join(root, '.tools', 'desktop-dist', 'win-unpacked', 'resources', 'service') : path.join(root, '.tools', 'desktop-stage', 'service');
const serviceOption = process.argv.indexOf('--service-directory');
if (serviceOption !== -1) {
  if (!process.argv[serviceOption + 1] || process.argv[serviceOption + 1].startsWith('--')) throw new Error('--service-directory 경로가 필요합니다');
  service = path.resolve(process.argv[serviceOption + 1]);
}
const isolated = process.argv.includes('--isolated');
const isolatedRoot = isolated ? fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'OpenSpecBoard-service-검증 공간-')) : undefined;
if (isolated) {
  fs.cpSync(service, path.join(isolatedRoot, 'service'), { recursive: true });
  service = path.join(isolatedRoot, 'service');
}
const dir = isolated ? path.join(isolatedRoot, 'profile') : fs.mkdtempSync(path.join(root, '.tools', 'desktop-service-검증 공간-'));
fs.mkdirSync(dir, { recursive: true });
const token = require('node:crypto').randomBytes(32).toString('hex');
const nodeBinary = path.join(service, 'runtime', 'node.exe');
const environment = { ...process.env, DESKTOP_TOKEN: token, DATA_DIR: path.join(dir, 'data'), CONFIG_PATH: path.join(dir, 'config.json'), OPENSPEC_NODE_DIRECTORY: path.join(service, 'runtime') };
fs.mkdirSync(environment.DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(environment.DATA_DIR, 'notifications.json'), JSON.stringify({ enabled: false, dashboardUrl: 'http://127.0.0.1:13001/' }));
const readOnlyService = process.argv.includes('--read-only-service');
if (readOnlyService && !isolated) throw new Error('--read-only-service에는 --isolated가 필요합니다');
const runtimeArgs = readOnlyService ? ['--permission', '--allow-fs-read=*', `--allow-fs-write=${dir}`, '--allow-child-process', '--allow-worker'] : [];
if (isolated) {
  // Remove inherited Node search paths, including differently cased Windows PATH keys.
  for (const key of Object.keys(environment)) if (['path', 'node_path', 'node_options'].includes(key.toLowerCase())) delete environment[key];
  environment.PATH = path.join(service, 'runtime');
}
// Pass the same test-only policy to the OpenSpec Node child, whose env inherits this.
if (readOnlyService) environment.NODE_OPTIONS = runtimeArgs.map(value => JSON.stringify(value)).join(' ');
let child, gateway, downloadFixture;
function spawnService() {
  return spawn(nodeBinary, [...runtimeArgs, path.join(service, 'backend', 'dist', 'desktop-main.js')], { cwd: dir, windowsHide: true, stdio: ['ignore','ignore','pipe','ipc'], env: environment });
}
async function start() {
  child = spawnService();
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  const upstream = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('서비스 준비 시간 초과')), 10000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`서비스 시작 실패 ${code}: ${errors}`)); });
    child.on('message', value => { if (value.type === 'ready') { clearTimeout(timer); resolve(`http://127.0.0.1:${value.port}/api/`); } });
  });
  const { createGateway } = require(path.join(service, 'backend', 'dist', 'gateway.js'));
  gateway = createGateway(Number(new URL(upstream).port), path.join(dir, 'data'), { staticDirectory: path.join(service, 'frontend'), token });
  await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  assert.equal((await fetch(origin)).status, 401);
  const page = await fetch(origin, { headers: { 'x-desktop-token': token } });
  assert.equal(page.status, 200); assert.match(await page.text(), /<html/i);
  return `${origin}/api/`;
}
async function call(base, route, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: { 'x-desktop-token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
}
async function stop(base, expectFailure = false) {
  await call(base, 'desktop/prepare', 'POST');
  await new Promise((resolve, reject) => {
    let backedUp = false, failed = false;
    const timer = setTimeout(() => reject(new Error('열린 SSE를 포함한 정상 종료 시간 초과')), 5000);
    child.on('message', value => { if (value.type === 'stopped') backedUp = true; if (value.type === 'shutdown-error') failed = true; });
    child.once('exit', code => { clearTimeout(timer); (expectFailure ? failed && code === 1 : backedUp && code === 0) ? resolve() : reject(new Error('백업 후 종료 상태 불일치')); });
    child.send({ type: 'shutdown' });
  });
  gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
  gateway = undefined;
}
async function rejectsDuplicate() {
  const duplicate = spawnService(); duplicate.stderr.resume();
  try {
    await new Promise((resolve, reject) => {
      let rejected = false;
      const timer = setTimeout(() => reject(new Error('중복 서비스 종료 시간 초과')), 10000);
      duplicate.on('message', value => { if (value?.type === 'startup-error') rejected = true; });
      duplicate.once('error', error => { clearTimeout(timer); reject(error); });
      duplicate.once('exit', code => { clearTimeout(timer); rejected && code === 1 ? resolve() : reject(new Error('중복 소유자 시작이 차단되지 않았습니다')); });
    });
  } finally { if (duplicate.exitCode === null) duplicate.kill(); }
}
async function listening(port) {
  return new Promise(resolve => {
    const socket = require('node:net').createConnection({ host: '127.0.0.1', port });
    const finish = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(1000, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
(async () => {
  const existing = await Promise.all([13001,13002,13003].map(listening));
  if (readOnlyService) {
    const probeCode = 'require("node:assert/strict").throws(()=>require("node:fs").writeFileSync(process.argv[1],"probe"),{code:"ERR_ACCESS_DENIED"})';
    for (const args of [
      ['-e', probeCode, path.join(service, 'read-only-probe')],
      ['-e', 'const p=require("node:child_process").spawnSync(process.execPath,["-e",process.argv[1],process.argv[2]],{env:process.env,encoding:"utf8"}); require("node:assert/strict").equal(p.status,0,p.stderr);', probeCode, path.join(service, 'read-only-probe')],
    ]) {
      const probe = spawnSync(nodeBinary, args, { cwd: dir, env: environment, windowsHide: true, encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr);
    }
    assert.equal(fs.existsSync(path.join(service, 'read-only-probe')), false);
    console.log('설치 리소스 쓰기 거절·별도 프로필 쓰기 허용 정책 검사 통과 (동봉 Node 권한 모델, Windows ACL 변경 없음)');
  }
  if (isolated) {
    const probe = spawnSync(nodeBinary, ['-e', 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(":memory:"); db.exec("CREATE TABLE test (id INTEGER)"); db.close(); console.log(JSON.stringify({binary:process.execPath,version:process.version}));'], { cwd: dir, env: environment, windowsHide: true, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const result = JSON.parse(probe.stdout); assert.equal(result.version, 'v24.15.0'); assert.equal(path.resolve(result.binary), path.resolve(nodeBinary));
    console.log('저장소 밖 동봉 Node·SQLite·시스템 Node PATH 차단 검사 통과');
  }
  let base = await start();
  assert.deepEqual((await call(base, 'sources')).sources, []);
  await rejectsDuplicate(); assert.equal((await call(base, 'desktop/status')).idle, true);
  if (process.argv.includes('--download-pipeline')) {
    await require('./desktop-startup-fixture.cjs').verifyStartupRecovery({ nodeBinary, service, environment, directory: dir, runtimeArgs });
    assert.equal((await call(base, 'desktop/status')).idle, true);
  }
  if (process.argv.includes('--backup-failure')) {
    fs.writeFileSync(path.join(dir, 'backups'), 'intentional fixture failure');
    await stop(base, true);
    assert.ok(fs.existsSync(path.join(dir, 'data', 'work.sqlite')));
    console.log(`백업 실패 시 오류 알림·종료·원본 보존 통과: ${dir}`); return;
  }
  const project = path.join(dir, 'project', 'openspec'); fs.mkdirSync(path.join(project, 'changes', 'smoke'), { recursive: true });
  fs.writeFileSync(path.join(project, 'changes', 'smoke', '.openspec.yaml'), 'schema: spec-driven\n');
  await call(base, 'config/sources', 'PUT', { sources: [{ name: 'smoke', path: project }] });
  const work = await call(base, 'work', 'POST', { sourceId: 'smoke', changeName: 'smoke', requestKey: 'smoke' });
  // Isolated persistence fixture only; no real AI account or thread is contacted.
  const { DatabaseSync } = require('node:sqlite');
  const fixtureDb = new DatabaseSync(path.join(dir, 'data', 'work.sqlite'));
  fixtureDb.prepare('UPDATE work SET data=? WHERE id=?').run(JSON.stringify({ ...work, threadId: 'thread-smoke-persisted' }), work.id); fixtureDb.close();
  const cli = await call(base, `work/${work.id}/openspec?operation=status`);
  assert.ok(cli.ok, '동봉 OpenSpec CLI 조회 실패');
  if (process.argv.includes('--busy-sessions')) {
    // Only this script's freshly created database is edited. No AI process/account is used.
    const { EventEmitter } = require('node:events');
    const { UpdateManager } = require('../desktop/updates.cjs');
    if (process.argv.includes('--download-pipeline')) downloadFixture = await require('./desktop-download-fixture.cjs').createDownloadFixture(dir);
    const updater = downloadFixture?.updater || new EventEmitter(); let installed = 0;
    updater.quitAndInstall = () => { installed++; };
    const manager = new UpdateManager({ updater, enabled: true, version: '0.1.0',
      prepare: async () => { await call(base, 'desktop/prepare', 'POST'); return 'isolated-test'; },
      stop: async () => {
        assert.equal((await fetch(base + 'work', { method: 'POST', headers: { 'x-desktop-token': token } })).status, 503, '설치 직전 신규 요청이 수락됐습니다');
        await stop(base);
      }, cancel: async () => call(base, 'desktop/cancel', 'POST') });
    if (downloadFixture) {
      for (const mode of ['disconnect', 'tampered']) {
        downloadFixture.setMode(mode); await manager.check();
        assert.equal(manager.snapshot().state, 'error'); assert.equal(manager.downloaded, false);
        await manager.install(); assert.equal(installed, 0); assert.equal(child.exitCode, null);
      }
      downloadFixture.setMode('valid'); await manager.check();
      assert.equal(manager.snapshot().state, 'ready');
      console.log('실제 다운로드 연결 단절·SHA-512 변조 오류 처리 및 정상 재다운로드 통과');
    } else updater.emit('update-downloaded', { version: '0.1.1' });
    const fixture = new DatabaseSync(path.join(dir, 'data', 'work.sqlite'));
    const other = { ...work, id: 'other-' + work.id, requestKey: 'other-smoke', changeName: 'other-smoke' };
    fixture.prepare('INSERT INTO work(id,request_key,source_id,change_name,data) VALUES(?,?,?,?,?)').run(other.id, other.requestKey, other.sourceId, other.changeName, JSON.stringify(other));
    const save = state => fixture.prepare('UPDATE work SET data=? WHERE id=?').run(JSON.stringify({ ...other, state }), other.id);
    for (const state of ['running', 'connecting', 'creating-thread', 'waiting-input', 'waiting-approval']) {
      save(state); assert.equal((await manager.install()).state, 'waiting');
      assert.equal(installed, 0); assert.equal(child.exitCode, null);
      assert.equal((await call(base, 'desktop/status')).locked, false);
    }
    save('idle');
    for (const kind of ['input', 'approval']) {
      fixture.prepare('INSERT OR REPLACE INTO records(id,work_id,kind,data) VALUES(?,?,?,?)').run('isolated-question', other.id, 'question', JSON.stringify({ kind, status: 'pending' }));
      assert.equal((await manager.install()).state, 'waiting'); assert.equal(installed, 0);
    }
    fixture.prepare('DELETE FROM records WHERE id=?').run('isolated-question');
    updater.emit('error', new Error('isolated download verification failure'));
    assert.equal((await manager.install()).state, 'error'); assert.equal(installed, 0);
    assert.equal(child.exitCode, null);
    fixture.close();
    if (downloadFixture) await manager.check();
    else updater.emit('update-downloaded', { version: '0.1.1' });
    assert.equal(installed, 0); // No automatic install after download.
    if (process.argv.includes('--update-backup-failure')) {
      const obstruction = path.join(dir, 'backups');
      fs.writeFileSync(obstruction, 'intentional update backup failure fixture');
      assert.equal((await manager.install()).state, 'error');
      assert.equal(installed, 0); assert.equal(child.exitCode, 1);
      assert.ok(fs.existsSync(path.join(dir, 'data', 'work.sqlite')));
      gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); gateway = undefined;
      fs.unlinkSync(obstruction);
      base = await start();
      const retained = (await call(base, 'work')).work.find(item => item.id === work.id);
      assert.equal(retained.threadId, 'thread-smoke-persisted');
      console.log('실제 백업 실패 시 설치 차단·원본 데이터 보존·동일 프로필 명시적 재시작 통과');
    }
    assert.equal((await manager.install()).state, 'installing'); assert.equal(installed, 1);
    assert.equal(child.exitCode, 0);
    await downloadFixture?.close(); downloadFixture = undefined;
    console.log('다른 업무의 실행·연결·질문·승인 보류, 검증 실패 차단, 명시적 유휴 설치 전 정상 종료·백업 통과 (설치기는 대역)');
    base = await start();
    assert.equal((await call(base, 'work')).work.find(item => item.id === work.id).threadId, 'thread-smoke-persisted');
  }
  const abort = new AbortController();
  const sse = await fetch(base + 'events', { headers: { 'x-desktop-token': token }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
  assert.equal(sse.status, 200); assert.match(sse.headers.get('content-type'), /text\/event-stream/);
  const reader = sse.body.getReader(); assert.equal((await reader.read()).done, false);
  const ended = reader.read().catch(() => ({ done: true }));
  await stop(base); abort.abort(); await ended;
  base = await start();
  const restored = (await call(base, 'work')).work.find(item => item.id === work.id); assert.ok(restored); assert.equal(restored.threadId, 'thread-smoke-persisted');
  await stop(base);
  const backups = fs.readdirSync(path.join(dir, 'backups')).sort();
  assert.ok(backups.length >= 2);
  // Restore the closed database and settings as a pair, then verify the same persisted work.
  fs.cpSync(path.join(dir, 'backups', backups.at(-1), 'data'), path.join(dir, 'data'), { recursive: true });
  fs.cpSync(path.join(dir, 'backups', backups.at(-1), 'config.json'), path.join(dir, 'config.json'));
  base = await start(); const fromBackup = (await call(base, 'work')).work.find(item => item.id === work.id); assert.ok(fromBackup); assert.equal(fromBackup.threadId, 'thread-smoke-persisted'); await stop(base);
  const remaining = await Promise.all([13001,13002,13003].map(listening));
  existing.forEach((wasListening, index) => { if (wasListening) assert.equal(remaining[index], true, `기존 ${13001 + index} 서버가 사라졌습니다`); });
  console.log(`동봉 Node·빈 프로젝트·CLI·SSE 종료·백업 복원·업무 복구 통과: ${dir}`);
  console.log(`중복 소유자 차단·시작 실패 후 재획득·게이트웨이·기존 포트 공존 통과: ${JSON.stringify({ before: existing, after: remaining })}`);
})().catch(async error => { console.error(error.message); await downloadFixture?.close(); gateway?.closeAllConnections(); gateway?.close(); if (child && child.exitCode === null) child.kill(); process.exitCode = 1; });
