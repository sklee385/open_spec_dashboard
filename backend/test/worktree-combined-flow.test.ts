import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createApplication } from '../src/app';
import { WorkStore, type Work } from '../src/work/store';
import { WorkService } from '../src/work/work.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorktreeManager } from '../src/work/worktree-manager';
import { collectWorkspaceDocuments } from '../src/work/workspace-documents';
import { projectCoordinator } from '../src/projects/coordinator';
vi.setConfig({ testTimeout: 300000, hookTimeout: 30000 });
const git=(root:string,...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const saved={CONFIG_PATH:process.env.CONFIG_PATH,DATA_DIR:process.env.DATA_DIR,WORKSPACE_ROOT:process.env.WORKSPACE_ROOT};
let app:any,base:string,root:string,source:string,store:WorkStore,works:WorkService,settings:WorkspaceSettingsService,a:Work,b:Work,initial:string;
const evidence:any={setup:'real Git and host workspace creation; trusted ready baseline fixture',actors:'two owned Node processes; no external model calls',events:[]};
const trace=(event:string,data:unknown={})=>{evidence.events.push({event,data});console.log('[ab-flow]',event,JSON.stringify(data));};
async function api(workId:string,path:string,body?:unknown,method=body===undefined?'GET':'POST') {const response=await fetch(`${base}/api/work/${workId}/${path}`,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};}
function ok(value:{status:number;data:any}) {expect(value,JSON.stringify(value.data)).toMatchObject({status:200});return value.data;}
async function fixture(id:string) {
 const work:Work={id,sourceId:'demo',projectPath:source,changeName:id,requestKey:id,ideaIds:[],phase:'verification',state:'idle',threadId:'thread-'+id,reviewedVersion:'plan',createdAt:'',updatedAt:''};store.save(work);
 await new WorktreeManager({store}).create(work,settings,{requestKey:'create-'+id,selectedBranch:'main',baseCommit:initial,sourceHead:initial});
 work.workspace!.status='ready';work.workspace!.workspaceBaselineCommit=initial;work.workspace!.sourcePlanRevision=collectWorkspaceDocuments(source,id).planRevision;store.save(work);work.reviewedVersion=works.planVersion(work);
 work.verificationCommands=[{id:'check-'+id,command:process.execPath,args:['-e',`const fs=require('fs');const value=fs.readFileSync('code.txt','utf8');if(!value.includes('${id.toUpperCase()}')||value.includes('<<<<<<<'))process.exit(1);console.log('verified '+value.trim());`]}];store.save(work);return work;
}
beforeAll(async()=>{
 root=mkdtempSync(join(tmpdir(),'ab-'));source=join(root,'s');mkdirSync(source);mkdirSync(join(root,'c'));
 git(source,'init','-b','main');git(source,'config','core.autocrlf','false');git(source,'config','user.name','Fixture');git(source,'config','user.email','fixture@example.test');
 for(const id of ['a','b']){const docs=join(source,'openspec/changes',id);mkdirSync(join(docs,'specs/demo'),{recursive:true});for(const name of ['proposal.md','design.md','specs/demo/spec.md'])writeFileSync(join(docs,name),'# Plan '+id+'\n');writeFileSync(join(docs,'tasks.md'),'- [x] 검증용 작업\n');}
 writeFileSync(join(source,'code.txt'),'base\n');writeFileSync(join(source,'keep.txt'),'원본 보존 데이터\n');git(source,'add','--all');git(source,'commit','-m','A/B 검증용 원본과 계획 초기화');initial=git(source,'rev-parse','HEAD');
 process.env.CONFIG_PATH=join(root,'c/config.json');process.env.DATA_DIR=join(root,'d');delete process.env.WORKSPACE_ROOT;writeFileSync(process.env.CONFIG_PATH,JSON.stringify({sources:[{name:'demo',path:join(source,'openspec')}]}));
 app=await createApplication();await app.listen(0,'127.0.0.1');base=await app.getUrl();store=app.get(WorkStore);works=app.get(WorkService);settings=app.get(WorkspaceSettingsService);const current=settings.read(),check=settings.check({version:current.version,path:join(root,'r')});settings.save({version:current.version,token:check.token,confirmed:true});a=await fixture('a');b=await fixture('b');evidence.fixture=root;evidence.initial=initial;
});
afterAll(async()=>{await app?.close();for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
async function developBoth() {
 const releases=[a,b].map(work=>projectCoordinator(store).acquireOperation({kind:'workspace',root:work.executionPath!,commonDir:work.workspace!.commonDir}));
 const children=[a,b].map(work=>{
  const child=spawn(process.execPath,['-e',"process.stdout.write('ready');process.stdin.once('data',()=>{require('fs').writeFileSync('code.txt',process.argv[1]+'\\n');process.exit(0);});",work.id.toUpperCase()],{cwd:work.executionPath!,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const ready=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',()=>resolve());});const closed=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Actor exit '+code)));});return {child,ready,closed};
 });
 try{await Promise.all(children.map(row=>row.ready));expect(children.every(row=>row.child.pid&&row.child.exitCode===null)).toBe(true);trace('parallel-actors',{pids:children.map(row=>row.child.pid)});children.forEach(row=>row.child.stdin.end('go'));await Promise.all(children.map(row=>row.closed));}finally{for(const row of children)if(row.child.exitCode===null)row.child.stdin.end('go');releases.forEach(release=>release());}
 expect(readFileSync(join(a.executionPath!,'code.txt'),'utf8')).toBe('A\n');expect(readFileSync(join(b.executionPath!,'code.txt'),'utf8')).toBe('B\n');expect(readFileSync(join(source,'code.txt'),'utf8')).toBe('base\n');
}
async function verifyWork(work:Work) {
 const run=ok(await api(work.id,'verify',{commandId:'check-'+work.id,scope:'full'}));
 await vi.waitFor(()=>expect(store.records(work.id,'verification').at(-1)?.status).not.toBe('running'),{timeout:20000,interval:100});
 const row=store.records(work.id,'verification').at(-1)!;expect(row).toMatchObject({status:'passed',code:0});expect(row.stdout).toContain('verified');trace('work-verified',{workId:work.id,runId:run.id,revision:row.revision});
}
async function reserveAndPrepare(work:Work) {
 const current=store.get(work.id)!;const reserved=ok(await api(work.id,'integration',{requestKey:randomUUID(),confirmed:true,targetBranch:'main',expectedWorkHead:git(work.executionPath!,'rev-parse','HEAD'),expectedTargetHead:git(source,'rev-parse','HEAD'),reviewedVersion:current.reviewedVersion}));
 const view=ok(await api(work.id,'integration/commit-preview'));const committed=ok(await api(work.id,'integration/result-commit',{integrationId:reserved.id,requestKey:randomUUID(),confirmed:true,previewVersion:view.version,paths:view.entries.filter((row:any)=>row.selectable).map((row:any)=>row.path),message:work.id+' 업무 검증 결과 커밋'}));expect(committed.status).toBe('committed');
 const candidate=ok(await api(work.id,`integration/${reserved.candidateId}/preview`));const prepared=ok(await api(work.id,`integration/${reserved.candidateId}/prepare`,{requestKey:randomUUID(),confirmed:true,expectedVersion:candidate.candidateVersion}));
 const stored=store.integrationRequests().find(row=>row.id===reserved.id)!;trace('candidate-prepared',{workId:work.id,candidateId:reserved.candidateId,resultCommit:committed.commit,targetHead:stored.targetHead,candidateCommit:stored.candidateCommit,status:prepared.status,diff:git(work.executionPath!,'diff-tree','--no-commit-id','--name-only','-r',committed.commit)});return stored;
}
async function verifyCandidate(work:Work,candidateId:string) {
 const view=ok(await api(work.id,`integration/${candidateId}/verification/preview`));expect(view.ready).toBe(false);
 const run=ok(await api(work.id,`integration/${candidateId}/verification/run`,{requestKey:randomUUID(),confirmed:true,candidateVersion:view.candidateVersion}));expect(run.status).toBe('running');
 await vi.waitFor(()=>expect(store.records(work.id,'candidate-verification').find(row=>row.id===run.id)?.status).not.toBe('running'),{timeout:30000,interval:100});
 const row=store.records(work.id,'candidate-verification').find(row=>row.id===run.id)!;expect(row,JSON.stringify({status:row.status,error:row.error,commands:row.commands})).toMatchObject({status:'passed',processTerminated:true});expect(row.commands[0].stdout).toContain('verified');const current=ok(await api(work.id,`integration/${candidateId}/verification/status`));expect(current.ready).toBe(true);trace('candidate-verified',{workId:work.id,candidateId,runId:row.id,candidateVersion:row.candidateVersion,termination:row.commands[0].terminationEvidence});
}
async function apply(work:Work,candidateId:string) {
 const before=ok(await api(work.id,`integration/${candidateId}/apply/preview`)),body={requestKey:randomUUID(),expectedVersion:before.expectedVersion,confirmed:true};const result=ok(await api(work.id,`integration/${candidateId}/apply`,body));expect(result.status).toBe('applied');expect(result.processTerminated).toBe(true);expect(git(source,'rev-parse','HEAD')).toBe(result.appliedCommit);expect(ok(await api(work.id,`integration/${candidateId}/apply`,body)).appliedCommit).toBe(result.appliedCommit);trace('applied',{workId:work.id,candidateId,appliedCommit:result.appliedCommit,targetHead:result.targetHead,attemptId:result.id});return result;
}
it('실제 A/B 독립 개발·검증 뒤 A 반영과 B 충돌 해결·후보 재검증·순차 반영이 원본 데이터를 보존한다',async()=>{
 const keep=createHash('sha256').update(readFileSync(join(source,'keep.txt'))).digest('hex');await developBoth();await Promise.all([verifyWork(a),verifyWork(b)]);const bBefore=git(b.executionPath!,'rev-parse','HEAD');
 const first=await reserveAndPrepare(a);expect(first.status).toBe('validating');await verifyCandidate(a,first.candidateId);const appliedA=await apply(a,first.candidateId);expect(readFileSync(join(source,'code.txt'),'utf8')).toBe('A\n');expect(git(b.executionPath!,'rev-parse','HEAD')).toBe(bBefore);expect(readFileSync(join(b.executionPath!,'code.txt'),'utf8')).toBe('B\n');
 const second=await reserveAndPrepare(b);expect(second.status).toBe('conflicted');expect(second.conflicts).toContain('code.txt');expect(second.targetHead).toBe(appliedA.appliedCommit);expect((await api(b.id,`integration/${second.candidateId}/apply/preview`)).status).toBe(409);
 const url=`${base}/api/projects/demo/file?workId=b&candidateId=${second.candidateId}&path=code.txt`,read=await(await fetch(url)).json();expect(read.content).toContain('<<<<<<<');
 const saved=await fetch(url,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({path:'code.txt',content:'A+B\n',version:read.version,candidateVersion:read.candidateVersion})});expect(saved.status).toBe(200);const changed=await saved.json();
 const staged=ok(await api(b.id,`integration/${second.candidateId}/edit/stage`,{requestKey:randomUUID(),confirmed:true,candidateVersion:changed.candidateVersion,paths:['code.txt']}));expect(staged.status).toBe('staged');
 const committed=ok(await api(b.id,`integration/${second.candidateId}/edit/commit`,{requestKey:randomUUID(),confirmed:true,candidateVersion:staged.afterVersion,paths:['code.txt'],message:'A 결과를 보존하며 B 충돌 해결'}));expect(committed.status).toBe('committed');expect(git(second.executionPath,'show','-s','--format=%P')).toBe(`${second.targetHead} ${second.resultCommit}`);expect((await api(b.id,`integration/${second.candidateId}/apply/preview`)).status).toBe(409);
 await verifyCandidate(b,second.candidateId);const appliedB=await apply(b,second.candidateId);expect(readFileSync(join(source,'code.txt'),'utf8')).toBe('A+B\n');expect(createHash('sha256').update(readFileSync(join(source,'keep.txt'))).digest('hex')).toBe(keep);expect(readFileSync(join(a.executionPath!,'code.txt'),'utf8')).toBe('A\n');expect(readFileSync(join(b.executionPath!,'code.txt'),'utf8')).toBe('B\n');expect(store.records(a.id,'integration-apply')).toHaveLength(1);expect(store.records(b.id,'integration-apply')).toHaveLength(1);expect(store.get(a.id)?.threadId).toBe('thread-a');expect(store.get(b.id)?.threadId).toBe('thread-b');
 evidence.appliedA=appliedA.appliedCommit;evidence.appliedB=appliedB.appliedCommit;evidence.final=git(source,'rev-parse','HEAD');evidence.keptHash=keep;writeFileSync(join(root,'ab-evidence.json'),JSON.stringify(evidence,null,2));trace('completed',{fixture:root,appliedA:evidence.appliedA,appliedB:evidence.appliedB,keptHash:keep});
});
