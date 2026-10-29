const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.resolve(process.argv[2] || path.join(root, '.tools/desktop-dist/win-unpacked'));
const archive = path.resolve(process.argv[3] || path.join(root, '.tools/desktop-dist', `OpenSpecBoard-${require('../package.json').version}-win-x64-portable.zip`));
const manifestPath = process.argv[4] ? path.resolve(process.argv[4]) : path.join(path.dirname(archive), 'portable.json');
const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'OpenSpecBoard-update-smoke-'));
const appDirectory = path.join(directory, 'app'), userDirectory = path.join(directory, 'profile');
fs.cpSync(source, appDirectory, { recursive: true }); fs.mkdirSync(userDirectory);
const marker = path.join(appDirectory, 'old-update-smoke-sentinel.txt'); fs.writeFileSync(marker, 'preserve-old-installation');
const configPath = path.join(directory, 'test-config.json'), resultPath = path.join(directory, 'prepared.json');
fs.writeFileSync(configPath, JSON.stringify({ source, archive, manifestPath, appDirectory, userDirectory, resultPath }));
const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(__dirname, 'desktop-portable-update-host.cjs'), configPath], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
let output = '', errors = '', timedOut = false; child.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); }); child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
const timeout = setTimeout(() => {
  timedOut = true; console.error('격리 업데이트 검사 시간 초과: ' + directory); process.exitCode = 1;
  // This is the exact host spawned above, never a user app or a process-name search.
  if (child.exitCode === null) { child.kill(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
}, 180000); timeout.unref();
child.once('error', error => { clearTimeout(timeout); console.error(error.message); process.exitCode = 1; });
child.once('exit', async code => {
  try {
    if (timedOut) throw Error('격리 업데이트 호스트 제한 시간 초과');
    if (code !== 0 || !output.includes('PORTABLE_ASAR_PREPARED')) throw Error('실제 Electron ASAR 업데이트 준비 실패: ' + errors);
    const prepared = JSON.parse(fs.readFileSync(resultPath, 'utf8')), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const job = JSON.parse(fs.readFileSync(prepared.configPath, 'utf8'));
    const deadline = Date.now() + 120000;
    for (;;) {
      if (timedOut) throw Error('격리 업데이트 검증 제한 시간 초과');
      let journal, state;
      try { journal = JSON.parse(fs.readFileSync(path.join(path.dirname(prepared.configPath), 'journal.json'), 'utf8')); } catch {}
      try { state = JSON.parse(fs.readFileSync(path.join(userDirectory, 'recovery-state.json'), 'utf8')); } catch {}
      if (journal?.status === 'complete' && state?.unclean === false) break;
      if (journal && !['waiting-parent','swapping','waiting-ready','complete'].includes(journal.status)) throw Error('격리 업데이트 교체 실패: ' + journal.status);
      if (Date.now() > deadline) throw Error('후보 앱 시작·정상 종료 확인 시간 초과');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const info = JSON.parse(fs.readFileSync(path.join(appDirectory, 'resources/service/build-info.json'), 'utf8'));
    if (info.version !== manifest.version || info.updateMode !== 'portable-github' || fs.existsSync(marker)) throw Error('설치 버전·무설치 모드·폴더 교체 검증 실패');
    if (fs.readFileSync(path.join(job.backupDirectory, path.basename(marker)), 'utf8') !== 'preserve-old-installation') throw Error('기존 앱 백업 누락');
    const backups = path.join(userDirectory, 'backups');
    if (!fs.readdirSync(backups).length) throw Error('후보 앱 정상 종료 백업 누락');
    const owner = JSON.parse(fs.readFileSync(path.join(userDirectory, 'desktop-owner.json'), 'utf8'));
    const processes = await require(path.join(source, 'resources/emergency/emergency.cjs')).runProcessTool({ action: 'snapshot' });
    if (timedOut || [owner.main, owner.service].some(identity => processes.some(item => item.pid === identity.pid))) throw Error('후보 앱·서비스 프로세스 종료 미확인');
    console.log(`실제 Electron ASAR 압축 해제·독립 helper·폴더 교체·기존 앱 백업·후보 v${info.version} 재시작·정상 종료 통과: ${directory}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { clearTimeout(timeout); }
});
