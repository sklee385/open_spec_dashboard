import { expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { guardBrowserProcess, guardWorkerPath } from '../src/browser/browser-job';

it('실제 IPC 자식과 다른 PID의 HANDLE은 Job 배정 전에 거부하고 타 소유 자식을 보존한다',async()=>{
 const previous=process.env.OPENSPEC_BROWSER_DIRECTORY;process.env.OPENSPEC_BROWSER_DIRECTORY=resolve('../.tools/qa-head-runtime');const children:ChildProcess[]=[];
 let handle:Awaited<ReturnType<typeof guardBrowserProcess>>|undefined,worker:ChildProcess|undefined,workerPid:number|undefined;
 const create=async()=>{const child=fork(resolve('test/fixtures/browser-identity-worker.cjs'),[],{execArgv:['--require',guardWorkerPath()],windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});children.push(child);await new Promise<void>((done,fail)=>{child.once('error',fail);child.once('message',(message:any)=>message.ready?done():fail(Error('owned worker readiness')));});return child;};
 try{worker=await create();const foreign=await create();workerPid=worker.pid;Object.defineProperty(worker,'pid',{configurable:true,writable:true,value:foreign.pid});
  const guarded=guardBrowserProcess(worker).then(value=>{handle=value;return value;});await expect(guarded).rejects.toThrow(/소유|신원|프로세스/);expect(foreign.exitCode).toBeNull();expect(worker.exitCode).toBeNull();
 }finally{if(worker&&workerPid)Object.defineProperty(worker,'pid',{configurable:true,writable:true,value:workerPid});for(const child of children)if(child.connected)child.send({finish:true},()=>{});for(const child of children){if(child.exitCode===null&&child.signalCode===null)await new Promise<void>(done=>{const timer=setTimeout(()=>{child.kill();},5000);child.once('close',()=>{clearTimeout(timer);done();});});}await handle?.done.catch(()=>{});if(previous===undefined)delete process.env.OPENSPEC_BROWSER_DIRECTORY;else process.env.OPENSPEC_BROWSER_DIRECTORY=previous;}
},20000);

it.each(['generic','head','browser'] as const)('실제 %s Job은 보유 HANDLE과 IPC 신원이 일치한 자식만 시작·종료한다',async mode=>{
 const previous=process.env.OPENSPEC_BROWSER_DIRECTORY,guardPath=process.env.OPENSPEC_BROWSER_GUARD_PATH;process.env.OPENSPEC_BROWSER_DIRECTORY=resolve('../.tools/qa-head-runtime');process.env.OPENSPEC_BROWSER_GUARD_PATH=resolve('../.tools/browser-guard-v2/BrowserGuard.exe');
 const child=fork(resolve('test/fixtures/browser-identity-worker.cjs'),[],{execArgv:['--require',guardWorkerPath()],windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});const closed=new Promise<void>(done=>child.once('close',()=>done()));let handle:Awaited<ReturnType<typeof guardBrowserProcess>>|undefined;
 try{await new Promise<void>((done,fail)=>{child.once('error',fail);child.once('message',(message:any)=>message.ready?done():fail(Error('readiness')));});const root=mkdtempSync(join(tmpdir(),'handle-')),head=join(root,'HEAD');writeFileSync(head,'ref: refs/heads/main\n');handle=await guardBrowserProcess(child,mode==='head'?{file:head,ref:'refs/heads/main'}:undefined,mode==='browser'?{browserProtocol:true}:undefined);expect(child.exitCode).toBeNull();child.send({finish:true});await closed;await handle.done;if(mode==='browser')expect(handle.terminationProof).toMatchObject({state:'job-quiescent',workerPid:child.pid,activeProcesses:0});
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;await handle?.done.catch(()=>{});if(previous===undefined)delete process.env.OPENSPEC_BROWSER_DIRECTORY;else process.env.OPENSPEC_BROWSER_DIRECTORY=previous;if(guardPath===undefined)delete process.env.OPENSPEC_BROWSER_GUARD_PATH;else process.env.OPENSPEC_BROWSER_GUARD_PATH=guardPath;}
},20000);
