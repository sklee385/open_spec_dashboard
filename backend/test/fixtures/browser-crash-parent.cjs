'use strict';
// Owned-process crash fixture. Never discovers or kills an arbitrary PID.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const mode=process.argv[2],root=process.argv[3]||process.argv[2];
const stop=path.join(root,'cooperative-stop'),heartbeat=path.join(root,'heartbeat');
if(mode==='leaf') {
  const write=()=>{if(fs.existsSync(stop)){process.exit(0);return;}fs.writeFileSync(heartbeat,String(Date.now()));};write();setInterval(write,100);process.send?.({pid:process.pid});
} else if(mode==='worker') {
  let started=false;process.on('disconnect',()=>{if(!started)process.exit(0);});
  process.on('message',message=>{if(message!=='go'||started)return;started=true;const leaf=cp.fork(__filename,['leaf',root],{execArgv:[],windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});leaf.once('message',info=>process.send?.({leafPid:info.pid}));leaf.once('close',()=>process.exit(0));});
} else {
  require('reflect-metadata');
  const {WorkStore}=require('../../dist/work/store.js');
  const {claimBrowser,checkpointBrowser}=require('../../dist/browser/browser-lease.js');
  const {guardBrowserProcess}=require('../../dist/browser/browser-job.js');
  const {randomUUID}=require('node:crypto');
  process.env.DATA_DIR=path.join(root,'data');let worker;
  process.on('message',message=>{if(message==='crash')process.exit(73);});
  (async()=>{
    const store=new WorkStore();store.save({id:'w',sourceId:'fixture',projectPath:path.join(root,'source'),changeName:'w',requestKey:'w',ideaIds:[],phase:'verification',state:'running',threadId:'preserved-thread',reviewedVersion:null,createdAt:'',updatedAt:''});
    const row={id:randomUUID(),workId:'w',owner:'user',candidateId:null,targetKind:'work',status:'running',snapshotStatus:'running',steps:[],createdAt:new Date().toISOString()};
    const lease=claimBrowser(store,row,()=>{});
    worker=cp.fork(__filename,['worker',root],{execArgv:[],windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
    const guard=await guardBrowserProcess(worker,undefined,{browserProtocol:true});
    const leafReady=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});worker.send('go');const leaf=await leafReady;
    row.processId=worker.pid;row.guardPid=guard.pid;row.dispatched=true;checkpointBrowser(store,lease,row,{intent:{scope:'workspace',root:path.join(root,'source'),status:'running',owner:lease.owner,runGeneration:lease.runGeneration}});
    process.send?.({ready:true,runId:row.id,workerPid:worker.pid,guardPid:guard.pid,leafPid:leaf.leafPid});
  })().catch(error=>{process.send?.({error:error.message});worker?.kill();process.exitCode=1;});
}
