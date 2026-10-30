import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { browserDirectory } from './browser-runtime';
import { stopOwnedProcess } from './browser-process';

export interface BrowserJobTermination { protocol: 'browser-job-v2'; state: 'job-quiescent'; workerPid: number; guardPid: number; activeProcesses: 0; at: string; }
export async function guardBrowserProcess(child: ChildProcess, head?: { file: string; ref: string }, options?: { browserProtocol: true }): Promise<{ done: Promise<void>; pid?: number; protocol?: 'browser-job-v2'; terminationProof?: BrowserJobTermination; requestStop?: () => void }> {
  if (process.platform !== 'win32') throw new Error('백그라운드 브라우저 검증은 현재 Windows에서 지원합니다');
  if (!child.pid) throw new Error('검증 실행기의 프로세스 ID가 없습니다');
  const workerPid = child.pid;
  const browser = options?.browserProtocol === true;
  if (browser && head) throw new Error('브라우저 Job과 HEAD pin 프로토콜을 혼합할 수 없습니다');
  const executable = browser && process.env.OPENSPEC_BROWSER_GUARD_PATH ? resolve(process.env.OPENSPEC_BROWSER_GUARD_PATH) : join(browserDirectory(), 'guard/BrowserGuard.exe');
  const helper = spawn(executable, [String(child.pid), String(process.pid), ...(browser ? ['BROWSER-JOB-V2'] : head ? [head.file, head.ref] : [])], { windowsHide: true, stdio: [browser ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
  let terminationProof: BrowserJobTermination | undefined;
  let ready = false, output = '';
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise<void>((resolve, reject) => {
    helper.once('error', () => { readyReject(new Error('프로세스 소유권 가드를 실행하지 못했습니다')); reject(new Error('소유권 가드 실행 실패')); });
    helper.once('close', code => {
      if (!ready) readyReject(new Error('Windows 실행 정책 또는 프로세스 소유권 설정을 확인해 주세요'));
      if (code === 0 && ready && (browser ? /(^|\n)QUIESCENT BROWSER-JOB-V2\r?\n/.test(output) : !head || output.includes('QUIESCENT HEAD-PIN-V1'))) {
        if (browser && helper.pid) terminationProof = { protocol: 'browser-job-v2', state: 'job-quiescent', workerPid, guardPid: helper.pid, activeProcesses: 0, at: new Date().toISOString() };
        resolve();
      } else reject(new Error('브라우저 프로세스 정리를 확인하지 못했습니다'));
    });
  });
  void done.catch(() => {});
  helper.stdout!.on('data', bytes => { output += bytes.toString(); if (!ready && (browser ? /(^|\n)READY BROWSER-JOB-V2\r?\n/.test(output) : head ? output.includes('READY HEAD-PIN-V1') : /(^|\n)READY\r?\n/.test(output))) { ready = true; readyResolve(); } if (output.length > 1000) output = output.slice(-1000); });
  const requestStop = () => { if (browser && helper.stdin?.writable) helper.stdin.write('STOP BROWSER-JOB-V2\n', () => {}); };
  const timer = setTimeout(() => { if (browser) { requestStop(); child.kill(); } else if (head) { void stopOwnedProcess(child).catch(() => {}); } else helper.kill(); readyReject(new Error('Windows 프로세스 소유권 준비 시간이 초과됐습니다')); }, 15000);
  try { await readiness; return { done, pid: helper.pid, protocol: browser ? 'browser-job-v2' : undefined, requestStop: browser ? requestStop : undefined, get terminationProof() { return terminationProof; } }; } finally { clearTimeout(timer); }
}
