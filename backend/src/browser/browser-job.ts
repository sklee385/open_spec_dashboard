import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { browserDirectory } from './browser-runtime';

export async function guardBrowserProcess(child: ChildProcess): Promise<{ done: Promise<void> }> {
  if (process.platform !== 'win32') throw new Error('백그라운드 브라우저 검증은 현재 Windows에서 지원합니다');
  if (!child.pid) throw new Error('검증 실행기의 프로세스 ID가 없습니다');
  const helper = spawn(join(browserDirectory(), 'guard/BrowserGuard.exe'), [String(child.pid), String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let ready = false, output = '';
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise<void>((resolve, reject) => {
    helper.once('error', () => { readyReject(new Error('프로세스 소유권 가드를 실행하지 못했습니다')); reject(new Error('소유권 가드 실행 실패')); });
    helper.once('exit', code => {
      if (!ready) readyReject(new Error('Windows 실행 정책 또는 프로세스 소유권 설정을 확인해 주세요'));
      if (code === 0 && ready) resolve(); else reject(new Error('브라우저 프로세스 정리를 확인하지 못했습니다'));
    });
  });
  void done.catch(() => {});
  helper.stdout.on('data', bytes => { output += bytes.toString(); if (!ready && output.includes('READY')) { ready = true; readyResolve(); } if (output.length > 1000) output = output.slice(-1000); });
  const timer = setTimeout(() => { helper.kill(); readyReject(new Error('Windows 프로세스 소유권 준비 시간이 초과됐습니다')); }, 15000);
  try { await readiness; return { done }; } finally { clearTimeout(timer); }
}
