import { expect, it, vi } from 'vitest';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkStore } from '../src/work/store';
import { BrowserService } from '../src/browser/browser.service';
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error:any){if(error.code==='ESRCH')return false;throw error;}};
it.each([false,true])('실제 호스트 종료 후 독립 종료 기록=%s를 대조하고 다른 프로세스를 보존한다',async(witness)=>{
 const root=mkdtempSync(join(tmpdir(),'crash-'));mkdirSync(join(root,'source'));const previous=process.env.DATA_DIR;let parent:ChildProcess|undefined,foreign:ChildProcess|undefined,store:WorkStore|undefined,browser:BrowserService|undefined;
 try {
  parent=fork(resolve('test/fixtures/browser-crash-parent.cjs'),[root],{execArgv:[],windowsHide:true,env:{...process.env,OPENSPEC_CRASH_WITNESS:witness?'1':'0',OPENSPEC_BROWSER_GUARD_PATH:resolve('../.tools/browser-guard-v2/BrowserGuard.exe')},stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';parent.stderr!.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);});
  const closed=new Promise<number|null>(resolve=>parent!.once('close',resolve));
  const ready:any=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned host readiness timeout '+stderr)),25000);parent!.once('error',error=>{clearTimeout(timer);reject(error);});parent!.once('close',code=>{clearTimeout(timer);reject(new Error('Owned host closed '+code+' '+stderr));});parent!.once('message',(message:any)=>{clearTimeout(timer);message.error?reject(new Error(message.error)):resolve(message);});});
  expect(ready).toMatchObject({ready:true,workerPid:expect.any(Number),guardPid:expect.any(Number),leafPid:expect.any(Number)});expect([ready.workerPid,ready.guardPid,ready.leafPid].every(alive)).toBe(true);
  parent.send!('crash');expect(await closed).toBe(73);
  await vi.waitFor(()=>expect([ready.workerPid,ready.guardPid,ready.leafPid].map(alive)).toEqual([false,false,false]),{timeout:15000,interval:100});
  const before=statSync(join(root,'heartbeat')).mtimeMs;await new Promise(resolve=>setTimeout(resolve,350));expect(statSync(join(root,'heartbeat')).mtimeMs).toBe(before);
  process.env.DATA_DIR=join(root,'data');store=new WorkStore();browser=new BrowserService(store);expect(browser.activity('w')).toMatchObject({running:false,busy:true,live:{id:ready.runId,status:'unknown'}});expect(()=>browser!.run('w')).toThrow();if(!witness)await expect(browser.reconcile('w',ready.runId,true)).rejects.toThrow();
  // Deliberate stale-PID trap against an unrelated process owned by this test.
  foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});await new Promise<void>((resolve,reject)=>{foreign!.once('spawn',resolve);foreign!.once('error',reject);});
  const slot=store.records('w','browser-slot')[0],row=store.records('w','browser-verification')[0];store.record(slot.id,'w','browser-slot',{...slot,status:'uncertain',processId:foreign.pid});store.record(row.id,'w','browser-verification',{...row,processId:foreign.pid,cleanupStatus:'uncertain'});
  const kill=vi.spyOn(process,'kill');try{await expect(browser.reconcile('w',ready.runId,true)).rejects.toThrow(/종료 근거/);expect(kill).not.toHaveBeenCalled();expect(foreign.exitCode).toBeNull();expect(browser.activity('w').busy).toBe(true);expect(store.get('w')?.threadId).toBe('preserved-thread');}finally{kill.mockRestore();}
  if(witness){const original=readFileSync(row.terminationWitness.file,'utf8');for(const invalid of [original.replace('QUIESCENT','READY'),original.slice(0,20),original.replace(row.terminationWitness.nonce,'0'.repeat(64))]){writeFileSync(row.terminationWitness.file,invalid);store.record(slot.id,'w','browser-slot',{...slot,status:'uncertain'});store.record(row.id,'w','browser-verification',{...row,cleanupStatus:'uncertain'});await expect(browser.reconcile('w',ready.runId,true)).rejects.toThrow(/종료 근거/);expect(browser.activity('w').busy).toBe(true);}writeFileSync(row.terminationWitness.file,original);store.record(slot.id,'w','browser-slot',{...slot,status:'uncertain'});store.record(row.id,'w','browser-verification',{...row,cleanupStatus:'uncertain'});const kill=vi.spyOn(process,'kill');try{expect(await browser.reconcile('w',ready.runId,true)).toMatchObject({status:'interrupted',cleanupStatus:'confirmed',processTerminated:true});expect(browser.activity('w').busy).toBe(false);expect(kill).not.toHaveBeenCalled();expect(foreign.exitCode).toBeNull();}finally{kill.mockRestore();}}
  console.log('[host-crash]',JSON.stringify({fixture:root,hostExit:73,workerPid:ready.workerPid,guardPid:ready.guardPid,leafPid:ready.leafPid,jobDescendantsGone:true,slot:witness?'settled-from-native-witness':'unknown-retained',foreignPid:foreign.pid,foreignPreserved:true}));
 }finally{
  writeFileSync(join(root,'cooperative-stop'),'stop');if(parent?.connected)parent.send('crash');else if(parent&&parent.exitCode===null)parent.kill();if(foreign&&foreign.exitCode===null)foreign.kill();await browser?.onModuleDestroy();store?.onApplicationShutdown();if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;
 }
},60000);
