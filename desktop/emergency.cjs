const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const OWNER_NAME = 'desktop-owner.json';
const normalize = value => path.resolve(value).toLowerCase();
const samePath = (a,b) => typeof a === 'string' && typeof b === 'string' && normalize(a) === normalize(b);
function installationDirectory() {
  // Both the asar module and the independent resources/emergency copy bind to
  // their containing installation, never to an installation named in a record.
  const parts = __dirname.split(path.sep);
  const resources = parts.lastIndexOf('resources');
  return resources >= 0 ? parts.slice(0,resources).join(path.sep) : path.resolve(__dirname,'..');
}
function powershellPath() { return path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'); }
function runProcessTool(payload) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows 전용 긴급 도구입니다'));
  return new Promise((resolve,reject) => {
    // Use the real, unpacked script: PowerShell cannot read an asar archive.
    const script = path.join(installationDirectory(),'resources','emergency','emergency-process.ps1');
    const child = spawn(powershellPath(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{ windowsHide:true,stdio:['pipe','pipe','pipe'] });
    let output = '', errors = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('긴급 도구 응답 시간 초과')); },30000);
    child.stdout.on('data',chunk => { output += chunk; if (output.length > 8*1024*1024) child.kill(); });
    child.stderr.on('data',chunk => { errors = (errors + chunk).slice(-2000); });
    child.once('error',error => { clearTimeout(timer); reject(error); });
    child.once('exit',code => { clearTimeout(timer); if (code !== 0) reject(new Error('프로세스 소유권 검사 또는 종료 실패')); else { try { resolve(JSON.parse(output.replace(/^\uFEFF/,''))); } catch { reject(new Error('프로세스 검사 응답 오류')); } } });
    child.stdin.on('error',() => {}); child.stdin.end(JSON.stringify(payload));
  });
}
async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try { await fs.writeFile(temp,JSON.stringify(value,null,2),{ flag:'wx',mode:0o600 }); await fs.rename(temp,file); }
  finally { await fs.rm(temp,{force:true}).catch(() => {}); }
}
function identityValid(value) {
  return value && Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.parentPid) && value.parentPid >= 0 && typeof value.executablePath === 'string' && path.isAbsolute(value.executablePath) && typeof value.createdAt === 'string' && /^\d{16,20}$/.test(value.createdAt);
}
function sameIdentity(a,b) { return identityValid(a) && identityValid(b) && a.pid === b.pid && a.createdAt === b.createdAt && samePath(a.executablePath,b.executablePath); }
function createEmergencyTools({ appDirectory = installationDirectory(), snapshot = () => runProcessTool({ action:'snapshot' }), terminate = identities => runProcessTool({ action:'terminate',identities }), selfPid = process.pid } = {}) {
  const mainPath = path.join(appDirectory,'OpenSpecBoard.exe');
  const servicePath = path.join(appDirectory,'resources','service','runtime','node.exe');
  async function captureOwner(options) {
    if (!samePath(options.appDirectory,appDirectory)) throw new Error('긴급 도구 설치 경로 불일치');
    const userDirectory = await fs.realpath(options.userDirectory);
    const processes = await snapshot();
    const main = processes.find(p => p.pid === options.pid), service = processes.find(p => p.pid === options.childPid);
    if (!identityValid(main) || !identityValid(service) || !samePath(main.executablePath,mainPath) || !samePath(service.executablePath,servicePath) || service.parentPid !== main.pid || BigInt(service.createdAt) < BigInt(main.createdAt)) throw new Error('앱 프로세스 소유권을 확인할 수 없습니다');
    const record = { version:1,nonce:randomBytes(16).toString('hex'),appDirectory:path.resolve(appDirectory),userDirectory,main,service,capturedAt:new Date().toISOString() };
    const ownerPath = path.join(userDirectory,OWNER_NAME); await atomicWrite(ownerPath,record);
    return { ownerPath,...record };
  }
  async function readOwner(ownerPath) {
    let record;
    try { const raw = await fs.readFile(ownerPath,'utf8'); if (raw.length > 16384) throw new Error(); record = JSON.parse(raw); } catch { throw new Error('긴급 종료 소유 레코드 손상'); }
    if (record.version !== 1 || !/^[a-f0-9]{32}$/.test(record.nonce) || !identityValid(record.main) || !identityValid(record.service) || typeof record.userDirectory !== 'string' || !path.isAbsolute(record.userDirectory) || !samePath(record.appDirectory,appDirectory) || !samePath(record.main.executablePath,mainPath) || !samePath(record.service.executablePath,servicePath) || record.service.parentPid !== record.main.pid || BigInt(record.service.createdAt) < BigInt(record.main.createdAt)) throw new Error('긴급 종료 소유 레코드 불일치');
    if (!samePath(ownerPath,path.join(record.userDirectory,OWNER_NAME)) || !samePath(await fs.realpath(path.dirname(ownerPath)),record.userDirectory) || (await fs.lstat(ownerPath)).isSymbolicLink()) throw new Error('소유 레코드 경로 불일치');
    return record;
  }
  async function terminateOwner({ ownerPath,confirm,expectedNonce,expectedOwner } = {}) {
    if (confirm !== true) throw new Error('강제 종료에는 사용자 확인이 필요합니다');
    const record = await readOwner(ownerPath);
    if ((expectedNonce !== undefined && record.nonce !== expectedNonce) || (expectedOwner && (record.nonce !== expectedOwner.nonce || !sameIdentity(record.main,expectedOwner.main) || !sameIdentity(record.service,expectedOwner.service)))) throw new Error('확인한 앱 소유권이 변경되었습니다');
    const processes = await snapshot(); const byPid = new Map(processes.map(p => [p.pid,p]));
    const main = byPid.get(record.main.pid), service = byPid.get(record.service.pid);
    if ((main && !sameIdentity(main,record.main)) || (service && !sameIdentity(service,record.service))) throw new Error('앱 프로세스 소유권이 변경되었습니다');
    if (main && service && service.parentPid !== main.pid) throw new Error('서비스 소유권이 변경되었습니다');
    const protectedPids = new Set([selfPid]);
    const protect = pid => { for (const p of processes) if (p.parentPid === pid && !protectedPids.has(p.pid)) { protectedPids.add(p.pid); protect(p.pid); } }; protect(selfPid);
    const ordered = [], seen = new Set();
    const walk = parent => {
      if (seen.has(parent.pid) || protectedPids.has(parent.pid)) return; seen.add(parent.pid);
      for (const child of processes) if (child.parentPid === parent.pid && identityValid(child) && BigInt(child.createdAt) >= BigInt(parent.createdAt)) walk(child);
      ordered.push(parent);
    };
    // A service can survive an already exited Electron owner. Its exact captured
    // identity remains the only allowed root in that case.
    if (service) walk(service);
    if (main) walk(main);
    // The termination helper verifies every exact identity again on an opened
    // process handle before killing; PID reuse between snapshot and kill fails.
    await atomicWrite(path.join(record.userDirectory,'recovery-state.json'),{ unclean:true,safeMode:true,at:new Date().toISOString(),reason:'emergency-termination',ownerNonce:record.nonce });
    const terminatedPids = ordered.length ? await terminate(ordered) : [];
    return { terminatedPids,ownerPath };
  }
  return { captureOwner,terminateOwner,readOwner };
}
const defaults = createEmergencyTools();
function createEmergencyLauncher({ appDirectory = installationDirectory(),readOwner = defaults.readOwner,spawnProcess = spawn } = {}) {
 return async function launchEmergency({ ownerPath,confirm = false,expectedNonce,onFailure }) {
  if (typeof ownerPath !== 'string' || !path.isAbsolute(ownerPath)) throw new Error('소유 레코드 경로가 필요합니다');
  const capturedOwner = await readOwner(ownerPath);
  if (expectedNonce !== undefined && capturedOwner.nonce !== expectedNonce) throw new Error('확인한 앱 소유권이 변경되었습니다');
  const node = path.join(appDirectory,'resources','service','runtime','node.exe');
  const script = path.join(appDirectory,'resources','emergency','emergency.cjs');
  let notified = false;
  const notify = code => {
    const error = Object.assign(new Error(code === 'HELPER_START_FAILED' ? '긴급 종료 도구를 시작하지 못했습니다' : '긴급 종료 도구가 소유권 검증 또는 종료를 완료하지 못했습니다'),{code});
    if (!notified) { notified = true; try { Promise.resolve(onFailure?.(error)).catch(() => {}); } catch {} }
    return error;
  };
  let child;
  try { child = spawnProcess(node,[script,'--owner',ownerPath,'--expected-nonce',expectedNonce ?? capturedOwner.nonce,...(confirm === true ? ['--confirmed'] : [])],{ detached:true,windowsHide:true,stdio:'ignore' }); }
  catch { throw notify('HELPER_START_FAILED'); }
  child.on('error',() => notify('HELPER_START_FAILED'));
  child.once('exit',code => { if (code !== 0) notify('HELPER_EXIT_FAILED'); });
  await new Promise((resolve,reject) => { child.once('spawn',resolve); child.once('error',() => reject(notify('HELPER_START_FAILED'))); });
  child.unref(); return { helperPid:child.pid };
 };
}
const launchEmergency = createEmergencyLauncher();
module.exports = { ...defaults,createEmergencyTools,createEmergencyLauncher,launchEmergency,runProcessTool };
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const nonceIndex = args.indexOf('--expected-nonce');
    const expectedNonce = nonceIndex >= 0 ? args[nonceIndex+1] : undefined;
    const confirmedFlag = args.includes('--confirmed');
    const allowedTail = nonceIndex === 2 && /^[a-f0-9]{32}$/.test(expectedNonce) ? (args.length === 4 || (args.length === 5 && args[4] === '--confirmed')) : nonceIndex === -1 && args.length === 2;
    if (args[0] !== '--owner' || !args[1] || !allowedTail) throw new Error('사용법: emergency.cjs --owner <desktop-owner.json>');
    const capturedOwner = await defaults.readOwner(args[1]);
    if (expectedNonce !== undefined && capturedOwner.nonce !== expectedNonce) throw new Error('확인한 앱 소유권이 변경되었습니다');
    const confirmed = confirmedFlag || await runProcessTool({ action:'confirm' });
    if (confirmed !== true) return;
    await defaults.terminateOwner({ownerPath:args[1],confirm:true,expectedNonce:capturedOwner.nonce,expectedOwner:capturedOwner});
  })().catch(() => { process.exitCode = 1; });
}
