import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { browserDirectory } from './browser-runtime';

export const guardWorkerPath = () => join(__dirname, '../../scripts/guard-worker.cjs');
export interface BrowserJobTermination { protocol: 'browser-job-v2'; state: 'job-quiescent'; workerPid: number; guardPid: number; activeProcesses: 0; at: string; }
export async function guardBrowserProcess(child: ChildProcess, head?: { file: string; ref: string }, options?: { browserProtocol: true; witness?: { file: string; nonce: string } }): Promise<{ done: Promise<void>; pid?: number; protocol?: 'browser-job-v2'; terminationProof?: BrowserJobTermination; requestStop?: () => void }> {
  if (process.platform !== 'win32') throw new Error('백그라운드 브라우저 검증은 현재 Windows에서 지원합니다');
  if (!child.pid || !child.connected || typeof child.send !== 'function') throw new Error('소유 대기 실행기의 신원 통로가 없습니다');
  const workerPid = child.pid, nonce = randomBytes(32).toString('hex'), browser = options?.browserProtocol === true;
  if (browser && head) throw new Error('브라우저 Job과 HEAD pin 프로토콜을 혼합할 수 없습니다');
  const executable = browser && process.env.OPENSPEC_BROWSER_GUARD_PATH ? resolve(process.env.OPENSPEC_BROWSER_GUARD_PATH) : join(browserDirectory(), 'guard/BrowserGuard.exe');
  const helper = spawn(executable, ['HANDLE-PROOF-V1', nonce, String(workerPid), String(process.pid), ...(browser ? ['BROWSER-JOB-V2', ...(options?.witness ? [options.witness.file, options.witness.nonce] : [])] : head ? [head.file, head.ref] : [])], { windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let terminationProof: BrowserJobTermination | undefined;
  let ready = false, requested = false, authorized = false, identityFailed = false, output = '';
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const failIdentity = (message: string) => { if (ready) return; identityFailed = true; readyReject(new Error(message)); helper.stdin?.end(); };
  const identityMessage = (message: any) => {
    if (!requested || authorized || identityFailed || message?.protocol !== 'openspec-handle-v1' || message.type !== 'response' || message.nonce !== nonce) return;
    if (message.pid !== workerPid) { failIdentity('프로세스 HANDLE과 실제 소유 자식의 신원이 다릅니다'); return; }
    authorized = true;
    helper.stdin!.write(`ASSIGN HANDLE-PROOF-V1 ${nonce}\n`, error => { if (error) failIdentity('프로세스 신원 승인 전송을 확인하지 못했습니다'); });
  };
  const earlyClose = () => { if (!ready) failIdentity('소유 대기 실행기가 신원 확인 전에 종료됐습니다'); };
  child.on('message', identityMessage); child.once('close', earlyClose);
  helper.stdin!.on('error', () => failIdentity('프로세스 소유권 가드의 통신이 종료됐습니다'));
  const done = new Promise<void>((resolve, reject) => {
    helper.once('error', () => { failIdentity('프로세스 소유권 가드를 실행하지 못했습니다'); reject(new Error('소유권 가드 실행 실패')); });
    helper.once('close', code => {
      if (!ready) failIdentity('최신 Windows 가드와 프로세스 소유 신원 확인이 필요합니다');
      if (code === 0 && ready && (browser ? /(^|\n)QUIESCENT BROWSER-JOB-V2\r?\n/.test(output) : !head || output.includes('QUIESCENT HEAD-PIN-V1'))) {
        if (browser && helper.pid) terminationProof = { protocol: 'browser-job-v2', state: 'job-quiescent', workerPid, guardPid: helper.pid, activeProcesses: 0, at: new Date().toISOString() };
        resolve();
      } else reject(new Error('브라우저 프로세스 정리를 확인하지 못했습니다'));
    });
  });
  void done.catch(() => {});
  helper.stdout!.on('data', bytes => {
    output += bytes.toString().replaceAll('\r', '');
    if (!requested && !identityFailed && output.includes(`BOUND HANDLE-PROOF-V1 ${nonce}\n`)) {
      requested = true;
      child.send({ protocol: 'openspec-handle-v1', type: 'challenge', nonce }, error => { if (error) failIdentity('실제 소유 자식의 신원 응답을 확인하지 못했습니다'); });
    }
    if (!ready && !identityFailed && authorized && output.includes('READY HANDLE-PROOF-V1') && (browser ? /(^|\n)READY BROWSER-JOB-V2\r?\n/.test(output) : head ? output.includes('READY HEAD-PIN-V1') : /(^|\n)READY\r?\n/.test(output))) { ready = true; readyResolve(); }
    if (output.length > 2000) output = output.slice(-2000);
  });
  const requestStop = () => { if (helper.stdin?.writable) helper.stdin.write('STOP HANDLE-PROOF-V1\n', () => {}); };
  const timer = setTimeout(() => { requestStop(); child.kill(); failIdentity('Windows 프로세스 소유권 준비 시간이 초과됐습니다'); }, 15000);
  try { await readiness; return { done, pid: helper.pid, protocol: browser ? 'browser-job-v2' : undefined, requestStop, get terminationProof() { return terminationProof; } }; }
  finally { clearTimeout(timer); child.off('message', identityMessage); child.off('close', earlyClose); }
}
