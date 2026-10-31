import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// A case performs multiple explicit Git/FD inspections; the default 5s is shorter than those bounded operations.
vi.setConfig({ testTimeout: 30000, hookTimeout: 15000 });
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WorkStore, type Work } from '../src/work/store';
import { LegacyService } from '../src/legacy/legacy.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorkspaceCleanup } from '../src/work/workspace-cleanup';
import { CompletedResults } from '../src/work/completed-results';
import { projectCoordinator } from '../src/projects/coordinator';
import * as gitRunner from '../src/projects/git-runner';
const git=(root:string,...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const saved={DATA_DIR:process.env.DATA_DIR,CONFIG_PATH:process.env.CONFIG_PATH,WORKSPACE_ROOT:process.env.WORKSPACE_ROOT};
let store:WorkStore,legacy:LegacyService,work:Work,cleanup:WorkspaceCleanup,source:string;
beforeEach(()=>{
 const dir=mkdtempSync(join(tmpdir(),'cl-'));source=join(dir,'s');mkdirSync(join(source,'openspec'),{recursive:true});mkdirSync(join(dir,'c'));
 git(source,'init','-b','main');git(source,'config','core.autocrlf','false');git(source,'config','user.name','Fixture');git(source,'config','user.email','fixture@example.test');writeFileSync(join(source,'code.txt'),'base');writeFileSync(join(source,'.gitignore'),'ignored.txt\n');git(source,'add','--all');git(source,'commit','-m','fixture');
 process.env.DATA_DIR=join(dir,'data');process.env.CONFIG_PATH=join(dir,'c/config.json');delete process.env.WORKSPACE_ROOT;writeFileSync(process.env.CONFIG_PATH,JSON.stringify({sources:[{name:'demo',path:join(source,'openspec')}]}));store=new WorkStore();legacy=new LegacyService();const settings=new WorkspaceSettingsService(legacy,store),config=settings.read(),checked=settings.check({version:config.version,path:join(dir,'r')});settings.save({version:config.version,token:checked.token,confirmed:true});const selected=settings.view(),root=selected.roots.find(row=>row.rootId===selected.selectedRootId)!;
 const workspaceId=randomUUID(),projectId=createHash('sha256').update(source).digest('hex'),container=join(root.managedPath,'projects',projectId,'works',workspaceId),path=join(container,'project');mkdirSync(container,{recursive:true});mkdirSync(join(container,'disabled-hooks'));const head=git(source,'rev-parse','HEAD');git(source,'worktree','add','-b','codex/work-a','--',path,'main');
 const space={version:1 as const,kind:'git-worktree' as const,status:'ready' as const,profileId:selected.profileId,rootId:root.rootId,rootPath:root.path,managedPath:root.managedPath,projectId,workspaceId,executionPath:path,commonDir:git(source,'rev-parse','--path-format=absolute','--git-common-dir'),branch:'codex/work-a',baseCommit:head,workspaceBaselineCommit:head};work={id:'a',requestKey:'a',sourceId:'demo',changeName:'a',projectPath:source,executionPath:path,workspace:space,phase:'completed',state:'idle',threadId:'same-thread',ideaIds:[],reviewedVersion:'review',createdAt:'',updatedAt:''};writeFileSync(join(container,'identity.json'),JSON.stringify({schemaVersion:1,workId:work.id,projectPath:source,...space}));store.save(work);new CompletedResults(store).capture(work,{files:[],source:'completed'},[]);cleanup=new WorkspaceCleanup(store,settings);
});
afterEach(async()=>{vi.restoreAllMocks();await legacy?.onModuleDestroy();store?.onApplicationShutdown();for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
it('정리 미리보기는 소유·반영된 clean 공간과 보존 기록만 표시하고 파일·브랜치·DB를 바꾸지 않는다',async()=>{
 const before=JSON.stringify(store.get(work.id)),head=git(source,'rev-parse','HEAD'),index=readFileSync(join(source,'.git/index')).toString('base64');const first=await cleanup.preview(work.id);
 expect(first).toMatchObject({canRemove:true,keepBranch:true,sourcePreserved:true,retainedPreserved:true,target:{path:work.executionPath,head},blockers:[]});expect(first.version).toMatch(/^[a-f0-9]{64}$/);expect((await cleanup.preview(work.id)).version).toBe(first.version);expect(JSON.stringify(store.get(work.id))).toBe(before);expect(git(source,'rev-parse','HEAD')).toBe(head);expect(readFileSync(join(source,'.git/index')).toString('base64')).toBe(index);expect(existsSync(work.executionPath!)).toBe(true);expect(git(source,'show-ref','--verify','refs/heads/codex/work-a')).toContain(head);
});
it('실행·질문·종료 미확인과 공간 점유는 정리 허가를 내지 않는다',async()=>{
 for(const state of ['running','waiting-input','recovery-required']){store.save({...work,state});expect((await cleanup.preview(work.id)).canRemove).toBe(false);}store.save(work);
 store.record('q',work.id,'question',{kind:'approval',status:'pending'});expect((await cleanup.preview(work.id)).blockers.map(row=>row.code)).toContain('pending-control-or-process');store.record('q',work.id,'question',{kind:'approval',status:'answered'});
 store.record('run',work.id,'browser-verification',{status:'blocked',cleanupStatus:'uncertain'});expect((await cleanup.preview(work.id)).canRemove).toBe(false);store.record('run',work.id,'browser-verification',{status:'interrupted',cleanupStatus:'confirmed',processTerminated:true});
 store.record('legacy-process',work.id,'workspace-git-intent',{status:'failed',terminationUnconfirmed:true,processId:12345});expect((await cleanup.preview(work.id)).canRemove).toBe(false);store.record('legacy-process',work.id,'workspace-git-intent',{status:'failed',terminationUnconfirmed:false,processTerminated:true});
 store.record('browser-global-slot',work.id,'browser-slot',{workId:work.id,status:'uncertain'});expect((await cleanup.preview(work.id)).canRemove).toBe(false);store.record('browser-global-slot',work.id,'browser-slot',{workId:work.id,status:'settled'});
 const release=projectCoordinator(store).acquireOperation({kind:'workspace',root:work.executionPath!,commonDir:work.workspace!.commonDir});try{expect((await cleanup.preview(work.id)).blockers.map(row=>row.code)).toContain('space-busy');}finally{release();}
});
it('미커밋·미확인 ignored·미반영 커밋과 소유 변경은 모두 보존하고 정리를 막는다',async()=>{
 writeFileSync(join(work.executionPath!,'code.txt'),'new edit');expect((await cleanup.preview(work.id)).blockers.map(row=>row.code)).toContain('dirty-or-unknown');writeFileSync(join(work.executionPath!,'code.txt'),'base');writeFileSync(join(work.executionPath!,'ignored.txt'),'keep local');expect((await cleanup.preview(work.id)).blockers.map(row=>row.code)).toContain('unknown-ignored');
 git(work.executionPath!,'add','--','code.txt');writeFileSync(join(work.executionPath!,'extra.txt'),'unapplied');git(work.executionPath!,'add','--','extra.txt');git(work.executionPath!,'commit','-m','unapplied');expect((await cleanup.preview(work.id)).blockers.map(row=>row.code)).toContain('unapplied-commits');
 writeFileSync(join(dirname(work.executionPath!),'identity.json'),JSON.stringify({workId:'other'}));expect((await cleanup.preview(work.id)).blockers.map(row=>row.code)).toContain('ownership-unavailable');expect(readFileSync(join(work.executionPath!,'ignored.txt'),'utf8')).toBe('keep local');expect(readFileSync(join(work.executionPath!,'extra.txt'),'utf8')).toBe('unapplied');
});

it('확인한 개별 Git 공간만 정상 제거하고 원본·보존 결과·브랜치·다른 파일을 유지하며 같은 요청은 반복하지 않는다',async()=>{
 const sourceHead=git(source,'rev-parse','HEAD'),sourceIndex=readFileSync(join(source,'.git/index')).toString('base64'),capture=new CompletedResults(store).header(work.id).retained.captureId;
 const preview=await cleanup.preview(work.id);expect(preview.canRemove).toBe(true);const body={requestKey:randomUUID(),token:preview.token,expectedVersion:preview.version,confirmed:true};const result=await cleanup.remove(work.id,body);
 expect(result).toMatchObject({status:'removed',processTerminated:true,keepBranch:true});expect(existsSync(work.executionPath!)).toBe(false);expect(existsSync(dirname(work.executionPath!))).toBe(false);expect(git(source,'rev-parse','HEAD')).toBe(sourceHead);expect(readFileSync(join(source,'.git/index')).toString('base64')).toBe(sourceIndex);expect(git(source,'show-ref','--verify','refs/heads/codex/work-a')).toContain(sourceHead);expect(new CompletedResults(store).header(work.id).retained.captureId).toBe(capture);expect(store.get(work.id)?.workspace?.status).toBe('removed');
 expect(await cleanup.remove(work.id,body)).toEqual(result);expect(store.records(work.id,'workspace-cleanup')).toHaveLength(1);expect(store.get(work.id)?.threadId).toBe('same-thread');
});
it('미리보기 뒤 파일·상태 변경과 다른 토큰·대상·force 입력은 삭제 없이 거부한다',async()=>{
 const preview=await cleanup.preview(work.id),body={requestKey:randomUUID(),token:preview.token,expectedVersion:preview.version,confirmed:true};writeFileSync(join(work.executionPath!,'code.txt'),'new edit after preview');
 await expect(cleanup.remove(work.id,body)).rejects.toThrow();expect(existsSync(work.executionPath!)).toBe(true);expect(readFileSync(join(work.executionPath!,'code.txt'),'utf8')).toBe('new edit after preview');expect(store.records(work.id,'workspace-cleanup')).toEqual([]);
 await expect(cleanup.remove(work.id,{...body,requestKey:randomUUID(),token:randomUUID()})).rejects.toThrow();await expect(cleanup.remove(work.id,{...body,force:true})).rejects.toThrow();expect(git(source,'rev-parse','HEAD')).toBe(work.workspace!.baseCommit);
 writeFileSync(join(work.executionPath!,'code.txt'),'base');const next=await cleanup.preview(work.id);mkdirSync(join(dirname(work.executionPath!),'foreign-empty'));const blocked=await cleanup.preview(work.id);expect(blocked.blockers.map(row=>row.code)).toContain('unknown-container-files');await expect(cleanup.remove(work.id,{requestKey:randomUUID(),token:next.token,expectedVersion:next.version,confirmed:true})).rejects.toThrow();expect(existsSync(work.executionPath!)).toBe(true);
});

it('미리보기 뒤 알 수 없는 빈 폴더 추가도 거부하고 Git 제거 후 생긴 새 파일을 강제로 지우지 않는다',async()=>{
 const preview=await cleanup.preview(work.id),body={requestKey:randomUUID(),token:preview.token,expectedVersion:preview.version,confirmed:true};
 const actual=gitRunner.runGit;vi.spyOn(gitRunner,'runGit').mockImplementation(async(root,args,options,optional)=>{const output=await actual(root,args,options,optional);if(args.includes('remove'))writeFileSync(join(dirname(work.executionPath!),'new-user-file.txt'),'keep new content');return output;});
 const result=await cleanup.remove(work.id,body);expect(result).toMatchObject({status:'uncertain',processTerminated:true});expect(readFileSync(join(dirname(work.executionPath!),'new-user-file.txt'),'utf8')).toBe('keep new content');expect(existsSync(join(dirname(work.executionPath!),'identity.json'))).toBe(true);expect(git(source,'rev-parse','HEAD')).toBe(work.workspace!.baseCommit);expect(new CompletedResults(store).header(work.id)).not.toBeNull();expect((await cleanup.preview(work.id)).canRemove).toBe(false);
});

it('확인 뒤 실제 공간 경로가 교체되면 기존 폴더와 새 폴더를 모두 보존한다',async()=>{
 const preview=await cleanup.preview(work.id),old=resolve(work.executionPath!),preserved=old+'-preserved';
 expect(old).toBe(resolve(work.workspace!.managedPath,'projects',work.workspace!.projectId,'works',work.workspace!.workspaceId,'project'));expect(dirname(preserved)).toBe(dirname(old));expect(old.startsWith(resolve(work.workspace!.managedPath)+sep)).toBe(true);
 renameSync(old,preserved);mkdirSync(old);writeFileSync(join(old,'new-user-file.txt'),'new path content');
 await expect(cleanup.remove(work.id,{requestKey:randomUUID(),token:preview.token,expectedVersion:preview.version,confirmed:true})).rejects.toThrow();
 expect(readFileSync(join(preserved,'code.txt'),'utf8')).toBe('base');expect(readFileSync(join(old,'new-user-file.txt'),'utf8')).toBe('new path content');expect(store.records(work.id,'workspace-cleanup')).toEqual([]);expect(git(source,'rev-parse','HEAD')).toBe(work.workspace!.baseCommit);
});

function preparedRuntimeData() {
 const container=dirname(work.executionPath!),root=join(container,'runtime-data'),space=work.workspace!,policyDigest='a'.repeat(64);
 mkdirSync(root);for(const name of ['tmp','home','npm-cache'])mkdirSync(join(root,name));writeFileSync(join(root,'identity.json'),JSON.stringify({schemaVersion:1,workId:work.id,workspaceId:space.workspaceId}));
 space.preparationPolicyDigest=policyDigest;store.save(work);store.record(work.id+':local-preparation',work.id,'workspace-local-preparation',{status:'ready',workspaceId:space.workspaceId,rootId:space.rootId,projectId:space.projectId,executionPath:work.executionPath,policyDigest});return root;
}
it('로컬 준비가 만든 소유 identity와 빈 runtime 폴더만 개별 정리하고 데이터 파일은 보존한다',async()=>{
 const runtime=preparedRuntimeData(),preview=await cleanup.preview(work.id);expect(preview,JSON.stringify(preview.blockers)).toMatchObject({canRemove:true,target:{runtimeData:true}});
 const result=await cleanup.remove(work.id,{requestKey:randomUUID(),token:preview.token,expectedVersion:preview.version,confirmed:true});expect(result.status).toBe('removed');expect(existsSync(runtime)).toBe(false);expect(existsSync(dirname(work.executionPath!))).toBe(false);expect(readFileSync(join(source,'code.txt'),'utf8')).toBe('base');expect(new CompletedResults(store).header(work.id)).not.toBeNull();
});
it('미리보기 뒤 runtime 자료가 생기면 삭제하지 않고 기존 데이터를 보존한다',async()=>{
 const runtime=preparedRuntimeData(),preview=await cleanup.preview(work.id);expect(preview.canRemove).toBe(true);
 writeFileSync(join(runtime,'home','keep.txt'),'keep');const blocked=await cleanup.preview(work.id);expect(blocked.canRemove).toBe(false);await expect(cleanup.remove(work.id,{requestKey:randomUUID(),token:preview.token,expectedVersion:preview.version,confirmed:true})).rejects.toThrow();expect(readFileSync(join(runtime,'home','keep.txt'),'utf8')).toBe('keep');
});
it('runtime 소유 불일치와 Git 제거 도중 생긴 자료는 보존하고 미확인 결과로 남긴다',async()=>{
 const runtime=preparedRuntimeData(),identity=join(runtime,'identity.json'),original=readFileSync(identity,'utf8'),record=store.records(work.id,'workspace-local-preparation')[0];
 writeFileSync(identity,JSON.stringify({schemaVersion:1,workId:work.id,workspaceId:randomUUID()}));expect((await cleanup.preview(work.id)).canRemove).toBe(false);writeFileSync(identity,original);
 store.record(record.id,work.id,'workspace-local-preparation',{...record,policyDigest:'b'.repeat(64)});expect((await cleanup.preview(work.id)).canRemove).toBe(false);store.record(record.id,work.id,'workspace-local-preparation',record);
 const preview=await cleanup.preview(work.id);expect(preview.canRemove).toBe(true);const head=git(source,'rev-parse','HEAD'),actual=gitRunner.runGit;
 vi.spyOn(gitRunner,'runGit').mockImplementation(async(root,args,options,optional)=>{const output=await actual(root,args,options,optional);if(args.includes('remove'))writeFileSync(join(runtime,'home','late.txt'),'preserve');return output;});
 const result=await cleanup.remove(work.id,{requestKey:randomUUID(),token:preview.token,expectedVersion:preview.version,confirmed:true});expect(result).toMatchObject({status:'uncertain',processTerminated:true});expect(readFileSync(join(runtime,'home','late.txt'),'utf8')).toBe('preserve');expect(readFileSync(identity,'utf8')).toBe(original);expect(git(source,'rev-parse','HEAD')).toBe(head);expect(new CompletedResults(store).header(work.id)).not.toBeNull();
});
