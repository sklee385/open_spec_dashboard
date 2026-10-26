import { execFile, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

/** Never kills a port owner or an unrelated Node/browser process. */
export async function stopOwnedProcess(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, error => {
      if (error && child.exitCode === null && child.signalCode === null) reject(new Error('검증 서버 종료를 확인하지 못했습니다')); else resolve();
    }));
  } else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
}
