import { afterAll,beforeAll,expect,it } from 'vitest';
import { Module,type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { CompletedResultsController } from '../src/work/completed-results.controller';
import { CompletedResults } from '../src/work/completed-results';
import { WorkStore } from '../src/work/store';
let store:WorkStore,app:INestApplication,base:string,captureId:string,imageId:string,reader:CompletedResults;
const saved=process.env.DATA_DIR,bytes=Buffer.from([255,216,255,217]),digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
@Module({controllers:[CompletedResultsController],providers:[{provide:WorkStore,useFactory:()=>store}]})class Fixture{}
beforeAll(async()=>{
  process.env.DATA_DIR=join(mkdtempSync(join(tmpdir(),'chttp-')),'data');store=new WorkStore();reader=new CompletedResults(store);
  const work={id:'a',sourceId:'fixture',projectPath:'C:/missing-completed-work',changeName:'a',requestKey:'a',ideaIds:[],phase:'completed',state:'idle',threadId:'preserved',reviewedVersion:null,createdAt:'',updatedAt:''};store.save(work);store.save({...work,id:'b',requestKey:'b',changeName:'b'});
  imageId=randomUUID();const envId=randomUUID(),dir=join(process.env.DATA_DIR,'verification-environments',envId,'evidence');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,imageId+'.jpg'),bytes);store.record(imageId,'a','browser-verification',{status:'passed',environmentId:envId,evidencePath:join(dir,imageId+'.jpg'),createdAt:new Date().toISOString()});
  captureId=reader.capture(work,{source:'completed',revision:'a'.repeat(64),application:'applied',files:[{path:'body.txt',status:'added',before:null,after:'body-only-on-explicit-request',beforeAvailability:'absent',afterAvailability:'text',beforeHash:null,afterHash:digest('body-only-on-explicit-request')}]},[{id:imageId,kind:'browser-verification'}]).retained.captureId;
  app=await NestFactory.create(Fixture,{logger:false});app.setGlobalPrefix('api');await app.listen(0,'127.0.0.1');base=(await app.getUrl())+'/api/work';
});
afterAll(async()=>{if(app)await app.close();else store?.onApplicationShutdown();if(saved===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=saved;});
it('실제 HTTP는 유실 공간을 읽지 않고 캡처별 목록과 명시 본문을 분리하고 업무·query경계를 지킨다',async()=>{
  const list=await fetch(`${base}/a/completion/files?captureId=${captureId}&after=0&limit=1`),page=await list.json();expect(list.status).toBe(200);expect(page).toMatchObject({workId:'a',captureId,files:[{ordinal:0,path:'body.txt'}]});expect(JSON.stringify(page)).not.toContain('body-only-on-explicit-request');
  expect(await(await fetch(`${base}/a/completion/file?captureId=${captureId}&ordinal=0`)).json()).toMatchObject({after:'body-only-on-explicit-request'});
  expect((await fetch(`${base}/b/completion/files?captureId=${captureId}`)).status).toBe(404);expect((await fetch(`${base}/a/completion/files?captureId=${captureId}&limit=1000`)).status).toBe(400);expect((await fetch(`${base}/a/completion/file?captureId=${captureId}&ordinal=0&path=other`)).status).toBe(400);
});
it('화면 HTTP는 같은 캡처의 JPEG만 제공하고 확인된 만료 뒤410과 링크없는 요약을 반환한다',async()=>{
  const image=await fetch(`${base}/a/completion/evidence/${imageId}?captureId=${captureId}`);expect(image.status).toBe(200);expect(image.headers.get('content-type')).toMatch(/^image\/jpeg/);expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
  expect((await fetch(`${base}/b/completion/evidence/${imageId}?captureId=${captureId}`)).status).toBe(404);
  reader.expireEvidence('a',captureId,imageId,{confirmed:true,expectedHash:digest(bytes)});expect((await fetch(`${base}/a/completion/evidence/${imageId}?captureId=${captureId}`)).status).toBe(410);
  const summary=await(await fetch(`${base}/a/completion/verifications?captureId=${captureId}`)).json();expect(summary.results[0].evidence).toMatchObject({state:'expired'});expect(summary.results[0].evidence.url).toBeUndefined();
});