const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createEmergencyTools } = require('../emergency.cjs');

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'osb-emergency-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const appDirectory = path.join(dir, 'app');
  const userDirectory = path.join(dir, 'user');
  await fs.mkdir(appDirectory); await fs.mkdir(userDirectory);
  const main = { pid: 100, parentPid: 1, executablePath: path.join(appDirectory, 'OpenSpecBoard.exe'), createdAt: '134000000000000001' };
  const service = { pid: 200, parentPid: 100, executablePath: path.join(appDirectory, 'resources/service/runtime/node.exe'), createdAt: '134000000000000002' };
  let processes = [main, service]; const killed = [];
  const tools = createEmergencyTools({ appDirectory, snapshot: async () => processes, terminate: async identities => { killed.push(...identities.map(p => p.pid)); return identities.map(p => p.pid); }, selfPid: 999 });
  return { ...tools, appDirectory, userDirectory, main, service, killed, setProcesses: value => { processes = value; } };
}

test('captures exact identities atomically without authentication tokens', async t => {
  const f = await fixture(t);
  const owner = await f.captureOwner({ ...f, pid: 100, childPid: 200 });
  assert.equal(owner.ownerPath, path.join(f.userDirectory, 'desktop-owner.json'));
  const record = JSON.parse(await fs.readFile(owner.ownerPath, 'utf8'));
  assert.equal(record.main.createdAt, f.main.createdAt);
  assert.equal(record.service.parentPid, 100);
  assert.match(record.nonce, /^[a-f0-9]{32}$/);
  assert.equal('token' in record, false);
});

test('requires explicit confirmation and leaves processes untouched', async t => {
  const f = await fixture(t); const { ownerPath } = await f.captureOwner({ ...f, pid: 100, childPid: 200 });
  await assert.rejects(f.terminateOwner({ ownerPath }), /확인/);
  assert.deepEqual(f.killed, []);
});

test('terminates owned trees leaf first, protects helper descendants and unrelated apps', async t => {
  const f = await fixture(t); const { ownerPath } = await f.captureOwner({ ...f, pid: 100, childPid: 200 });
  const descendant = (pid, parentPid) => ({ pid, parentPid, executablePath: 'C:\\external\\codex.exe', createdAt: `13400000000000${String(pid).padStart(4,'0')}` });
  f.setProcesses([f.main, f.service, descendant(300,200), descendant(400,1), descendant(999,100), descendant(888,999)]);
  const result = await f.terminateOwner({ ownerPath, confirm: true });
  assert.deepEqual(f.killed, [300,200,100]);
  assert.deepEqual(result.terminatedPids, [300,200,100]);
  const marker = JSON.parse(await fs.readFile(path.join(f.userDirectory,'recovery-state.json'),'utf8'));
  assert.equal(marker.unclean, true); assert.equal(marker.safeMode,true);
});

test('rejects reused owner PID, different paths and unrelated service parent', async t => {
  for (const update of [{ createdAt: '134000000000000009' },{ executablePath: 'C:\\other\\OpenSpecBoard.exe' }]) {
    const f = await fixture(t); const { ownerPath } = await f.captureOwner({ ...f, pid:100, childPid:200 });
    f.setProcesses([{ ...f.main, ...update }, f.service]);
    await assert.rejects(f.terminateOwner({ ownerPath, confirm:true }), /소유/); assert.deepEqual(f.killed,[]);
  }
  const f = await fixture(t); f.setProcesses([f.main,{ ...f.service, parentPid: 777 }]);
  await assert.rejects(f.captureOwner({ ...f,pid:100,childPid:200 }), /소유/);
});

test('can clean the exact recorded service after main exits but rejects reused service PID', async t => {
  const f = await fixture(t); const { ownerPath } = await f.captureOwner({ ...f,pid:100,childPid:200 });
  f.setProcesses([{ ...f.service,createdAt:'134000000000000099' }]);
  await assert.rejects(f.terminateOwner({ ownerPath,confirm:true }), /소유/); assert.deepEqual(f.killed,[]);
  f.setProcesses([f.service]);
  await f.terminateOwner({ ownerPath,confirm:true }); assert.deepEqual(f.killed,[200]);
});

test('rejects corrupt registry, outside installation, and relocated registry', async t => {
  const f = await fixture(t);
  await assert.rejects(f.captureOwner({ ...f, appDirectory:path.dirname(f.appDirectory),pid:100,childPid:200 }), /설치/);
  const { ownerPath } = await f.captureOwner({ ...f,pid:100,childPid:200 });
  const elsewhere = path.join(f.appDirectory,'desktop-owner.json');
  await fs.copyFile(ownerPath, elsewhere);
  await assert.rejects(f.terminateOwner({ ownerPath:elsewhere,confirm:true }), /경로/);
  await fs.writeFile(ownerPath,'{"version":1,"main":{"pid":100}}');
  await assert.rejects(f.terminateOwner({ ownerPath,confirm:true }), /레코드/);
  assert.deepEqual(f.killed,[]);
});

const { spawn } = require('node:child_process');
function nativeTool(payload) {
  return new Promise((resolve,reject) => {
    const script = path.join(__dirname,'..','emergency-process.ps1');
    const binary = path.join(process.env.SystemRoot || 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(binary,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output = '', errors = '';
    child.stdout.on('data',value => { output += value; }); child.stderr.on('data',value => { errors += value; });
    child.on('error',reject); child.on('exit',code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('native process handles reject reused identity and kill only a newly created isolated fixture', {skip:process.platform !== 'win32',timeout:30000}, async t => {
  const fixtureProcess = spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{windowsHide:true,stdio:'ignore'});
  const sentinel = spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{windowsHide:true,stdio:'ignore'});
  t.after(() => { fixtureProcess.kill(); sentinel.kill(); });
  await Promise.all([new Promise(resolve => fixtureProcess.once('spawn',resolve)),new Promise(resolve => sentinel.once('spawn',resolve))]);
  const snapshot = await nativeTool({action:'snapshot'});
  const identity = snapshot.find(p => p.pid === fixtureProcess.pid);
  assert.ok(identity); assert.equal(path.resolve(identity.executablePath).toLowerCase(),path.resolve(process.execPath).toLowerCase());
  assert.match(identity.createdAt,/^\d{18}$/);
  await assert.rejects(nativeTool({action:'terminate',identities:[{ ...identity,createdAt:(BigInt(identity.createdAt)+1n).toString() }]}),/verification/);
  assert.equal(fixtureProcess.exitCode,null);
  await assert.rejects(nativeTool({action:'terminate',identities:[{ ...identity,executablePath:path.join(path.dirname(identity.executablePath),'another-app.exe') }]}),/verification/);
  const terminated = await nativeTool({action:'terminate',identities:[identity]});
  assert.deepEqual(terminated,[fixtureProcess.pid]);
  assert.equal(sentinel.exitCode,null);
});

test('native helper uses exact file time and revalidates on an open handle', async () => {
  const script = await fs.readFile(path.join(__dirname,'..','emergency-process.ps1'),'utf8');
  assert.match(script,/GetProcessTimes/); assert.match(script,/QueryFullProcessImageNameW/);
  assert.match(script,/MessageBoxDefaultButton\]::Button2/);
  assert.ok(script.indexOf('item.createdAt != created') < script.indexOf('if (!TerminateProcess(handle,1))'));
  assert.doesNotMatch(script,/taskkill|Stop-Process|Win32_Process/);
});

test('refuses an owner that exists but cannot be inspected', async t => {
  const f = await fixture(t); const { ownerPath } = await f.captureOwner({ ...f,pid:100,childPid:200 });
  f.setProcesses([{ pid:100,parentPid:1,executablePath:null,createdAt:null },f.service]);
  await assert.rejects(f.terminateOwner({ownerPath,confirm:true}),/소유/);
  assert.deepEqual(f.killed,[]);
});

test('native snapshot preserves inaccessible PIDs instead of treating them as exited', {skip:process.platform !== 'win32',timeout:15000}, async () => {
  const snapshot = await nativeTool({action:'snapshot'});
  assert.ok(snapshot.some(process => process.pid === 4), 'Windows System PID must remain represented even when inspection is denied');
});

test('confirmation cannot transfer to a replacement owner record', async t => {
  const f = await fixture(t); const previous = await f.captureOwner({ ...f,pid:100,childPid:200 });
  const replacement = await f.captureOwner({ ...f,pid:100,childPid:200 });
  assert.notEqual(previous.nonce,replacement.nonce);
  await assert.rejects(f.terminateOwner({ownerPath:previous.ownerPath,confirm:true,expectedNonce:previous.nonce}),/소유/);
  assert.deepEqual(f.killed,[]);
});

test('confirmation binds the exact main and service identities as well as nonce', async t => {
  const f = await fixture(t); const previous = await f.captureOwner({ ...f,pid:100,childPid:200 });
  const changed = {...previous,main:{...previous.main,createdAt:'134000000000000000'}};
  delete changed.ownerPath; await fs.writeFile(previous.ownerPath,JSON.stringify(changed));
  f.setProcesses([changed.main,f.service]);
  await assert.rejects(f.terminateOwner({ownerPath:previous.ownerPath,confirm:true,expectedOwner:previous}),/소유/);
  assert.deepEqual(f.killed,[]);
});

test('native handle inspection rejects stale Toolhelp parent metadata', {skip:process.platform !== 'win32',timeout:15000}, async t => {
  const fixtureProcess = spawn(process.execPath,['-e','setInterval(() => {},1000)'],{windowsHide:true,stdio:'ignore'});
  t.after(() => fixtureProcess.kill()); await new Promise(resolve => fixtureProcess.once('spawn',resolve));
  const source = await fs.readFile(path.join(__dirname,'..','emergency-process.ps1'),'utf8');
  const csharp = source.match(/Add-Type -TypeDefinition @"\r?\n([\s\S]+?)\r?\n"@/)[1];
  const script = `Add-Type -TypeDefinition @"\n${csharp}\n"@\n$process = [Diagnostics.Process]::GetProcessById(${fixtureProcess.pid})\n$method = [EmergencyNative].GetMethod('Read',[Reflection.BindingFlags]'NonPublic,Static')\n$identity = $method.Invoke($null,@($process.Handle,[int]${fixtureProcess.pid},[int]123456789))\nif ($null -ne $identity) { throw 'Stale Toolhelp parent was accepted' }\n`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'osb-native-race-')); t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const scriptPath = path.join(dir,'race.ps1'); await fs.writeFile(scriptPath,script);
  await new Promise((resolve,reject) => {
    const binary = path.join(process.env.SystemRoot || 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(binary,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',scriptPath],{windowsHide:true});
    let errors=''; child.stderr.on('data',data => { errors+=data; }); child.on('error',reject); child.on('exit',code => code===0?resolve():reject(new Error(errors)));
  });
});

test('detached helper reports sanitized failures once and contains callback exceptions', async t => {
  const {createEmergencyLauncher} = require('../emergency.cjs');
  const {EventEmitter} = require('node:events');
  const fakeChild = new EventEmitter(); fakeChild.pid=123; fakeChild.unref=() => {};
  const owner = {nonce:'a'.repeat(32)}; const failures=[];
  const launch = createEmergencyLauncher({appDirectory:os.tmpdir(),readOwner:async()=>owner,spawnProcess:()=> {queueMicrotask(()=>fakeChild.emit('spawn'));return fakeChild;}});
  const result = await launch({ownerPath:path.join(os.tmpdir(),'desktop-owner.json'),expectedNonce:owner.nonce,confirm:true,onFailure:error=>{failures.push(error);throw new Error('callback exception');}});
  assert.equal(result.helperPid,123);
  assert.doesNotThrow(()=>fakeChild.emit('error',new Error('secret path and token')));
  assert.doesNotThrow(()=>fakeChild.emit('exit',1));
  assert.equal(failures.length,1); assert.equal(failures[0].code,'HELPER_START_FAILED');
  assert.doesNotMatch(failures[0].message,/secret|token/);
});

test('detached helper rejects changed confirmation before spawning and reports nonzero exit', async () => {
  const {createEmergencyLauncher} = require('../emergency.cjs'); const {EventEmitter} = require('node:events');
  const fakeChild = new EventEmitter(); fakeChild.pid=124;fakeChild.unref=()=>{};let spawned=0;let failure;
  const launch = createEmergencyLauncher({appDirectory:os.tmpdir(),readOwner:async()=>({nonce:'b'.repeat(32)}),spawnProcess:()=>{spawned++;queueMicrotask(()=>fakeChild.emit('spawn'));return fakeChild;}});
  await assert.rejects(launch({ownerPath:path.join(os.tmpdir(),'desktop-owner.json'),expectedNonce:'a'.repeat(32),confirm:true}),/소유/);assert.equal(spawned,0);
  await launch({ownerPath:path.join(os.tmpdir(),'desktop-owner.json'),expectedNonce:'b'.repeat(32),confirm:true,onFailure:error=>{failure=error;}});
  fakeChild.emit('exit',7);assert.equal(failure.code,'HELPER_EXIT_FAILED');
});

test('detached helper also contains rejected async failure callbacks', async () => {
  const {createEmergencyLauncher} = require('../emergency.cjs');const {EventEmitter}=require('node:events');
  const child = new EventEmitter();child.pid=125;child.unref=()=>{};
  const launch = createEmergencyLauncher({appDirectory:os.tmpdir(),readOwner:async()=>({nonce:'c'.repeat(32)}),spawnProcess:()=>{queueMicrotask(()=>child.emit('spawn'));return child;}});
  await launch({ownerPath:path.join(os.tmpdir(),'desktop-owner.json'),onFailure:async()=>{throw new Error('async callback failure');}});
  child.emit('exit',1);await new Promise(resolve=>setImmediate(resolve));
});
