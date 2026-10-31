import { type ChildProcess } from 'node:child_process';

/** Stop only a retained native child handle; the independent Job drains descendants. */
export async function stopOwnedProcess(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    if (!child.kill() && child.exitCode === null && child.signalCode === null) throw new Error('소유 실행기 종료를 확인하지 못했습니다');
  } else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
}
