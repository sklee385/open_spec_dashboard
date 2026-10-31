import { expect, it, vi } from 'vitest';
const calls=vi.hoisted(()=>({execFile:vi.fn((_file:any,_args:any,_options:any,done:any)=>done(null))}));
vi.mock('node:child_process',async original=>({...await original<any>(),execFile:calls.execFile}));
import { stopOwnedProcess } from '../src/browser/browser-process';
it.runIf(process.platform==='win32')('Windows 중단은 공개 PID로 taskkill하지 않고 보유 ChildProcess 핸들만 사용한다',async()=>{
 const child:any={pid:12345,exitCode:null,signalCode:null,kill:vi.fn(()=>true)};await stopOwnedProcess(child);expect(child.kill).toHaveBeenCalledTimes(1);expect(calls.execFile).not.toHaveBeenCalled();
});
