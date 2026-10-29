const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(root, '.tools', 'desktop-smoke-검증 공간-'));
const development = process.argv.includes('--development-runtime');
let binary = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : development ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe') : path.join(root, '.tools', 'desktop-dist', 'win-unpacked', 'OpenSpecBoard.exe');
if (process.argv.includes('--copy-to-temp')) {
  const target = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'OpenSpecBoard-smoke-'));
  fs.cpSync(path.dirname(binary), path.join(target, 'app'), { recursive: true });
  binary = path.join(target, 'app', path.basename(binary));
}
const args = development ? [path.join(root, '.tools', 'desktop-stage'), '--desktop-smoke-test'] : ['--desktop-smoke-test'];
if (process.argv.includes('--lifecycle')) args.push('--desktop-lifecycle-test');
if (process.argv.includes('--personal-update')) args.push('--desktop-personal-update-test');
if (process.argv.includes('--renderer-recovery')) args.push('--desktop-recovery-test');
if (process.argv.includes('--health')) args.push('--desktop-health-test');
const child = spawn(binary, args, { windowsHide: !process.argv.includes('--lifecycle'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DESKTOP_SMOKE_DIRECTORY: dir } });
let output = ''; let errors = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { errors += chunk; });
const timer = setTimeout(() => { console.error('smoke 시간 초과. 격리한 테스트 앱 프로세스만 확인해 종료해 주세요.'); process.exitCode = 1; }, 60000); timer.unref();
child.on('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.on('exit', code => {
  clearTimeout(timer);
  const backups = path.join(dir, 'backups');
  if (code !== 0 || !output.includes('DESKTOP_SMOKE_READY') || (process.argv.includes('--security') && !output.includes('DESKTOP_SECURITY_READY')) || (process.argv.includes('--lifecycle') && !output.includes('DESKTOP_LIFECYCLE_READY')) || (process.argv.includes('--personal-update') && !output.includes('DESKTOP_PERSONAL_UPDATE_READY')) || (process.argv.includes('--renderer-recovery') && !output.includes('DESKTOP_RECOVERY_READY')) || (process.argv.includes('--health') && !output.includes('DESKTOP_HEALTH_READY')) || !fs.existsSync(backups) || !fs.readdirSync(backups).length) {
    console.error(`smoke 실패 (exit ${code}): ${errors.slice(-3000)}`); process.exitCode = 1; return;
  }
  console.log(`데스크톱 프로세스 기동·인증 API·빈 프로젝트·정상 종료·백업 smoke 통과: ${dir}`);
  if (output.includes('DESKTOP_SECURITY_READY')) console.log('Electron 실제 렌더러 격리·업데이트 메인 프레임 IPC 통과');
  if (output.includes('DESKTOP_LIFECYCLE_READY')) console.log('Electron 실제 창 닫기·숨김·트레이 재열기 콜백·서비스 유지 통과');
  if (output.includes('DESKTOP_PERSONAL_UPDATE_READY')) console.log('개인용 미서명 GitHub 업데이트 활성·정상 상태 IPC 통과');
  if (output.includes('DESKTOP_RECOVERY_READY')) console.log('실제 Electron 렌더러 충돌·화면 재로드·동일 세션 유지 통과');
  if (output.includes('DESKTOP_HEALTH_READY')) console.log('실제 소유권·진단 창 IPC·안전 모드 적용과 해제 통과');
});
