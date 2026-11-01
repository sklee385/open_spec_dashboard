import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkService } from '../src/work/work.service';
import { WorkStore } from '../src/work/store';
let root: string, docs: string, app: INestApplication, base: string, id: string;
async function get(path: string) { const res = await fetch(`${base}/api/${path}`); return { status: res.status, data: await res.json() }; }
beforeAll(async () => {
 root = mkdtempSync(join(tmpdir(), 'work-documents-')); docs = join(root, 'openspec/changes/feature'); mkdirSync(join(docs,'specs/feature'),{recursive:true});
 for(const file of ['proposal.md','design.md','tasks.md','specs/feature/spec.md'])writeFileSync(join(docs,file),'# Synthetic document\n');
 process.env.CONFIG_PATH=join(root,'config.json');process.env.DATA_DIR=join(root,'data');writeFileSync(process.env.CONFIG_PATH,JSON.stringify({sources:[{name:'fixture',path:'./openspec'}]}));
 app=await createApplication();await app.listen(0,'127.0.0.1');base=await app.getUrl();const res=await fetch(base+'/api/work',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceId:'fixture',changeName:'feature',requestKey:'fixture-create'})});id=(await res.json()).id;
});
afterAll(async()=>{await app?.close();delete process.env.CONFIG_PATH;delete process.env.DATA_DIR;});
it('discovers newly created supplemental change documents on the next read without inventing AI provenance',async()=>{
 const service=app.get(WorkService),before=service.planVersion(service.get(id));
 expect((await get(`work/${id}`)).data.documents).not.toContain('review-notes.md');
 mkdirSync(join(docs,'reports'));writeFileSync(join(docs,'review-notes.md'),'# Synthetic review');writeFileSync(join(docs,'reports/spec-analysis.md'),'# Synthetic analysis');
 const result=await get(`work/${id}`);expect(result.status).toBe(200);expect(result.data.documents).toEqual(expect.arrayContaining(['proposal.md','specs/feature/spec.md','review-notes.md','reports/spec-analysis.md']));
 const doc=await get(`work/${id}/document?path=reports%2Fspec-analysis.md`);expect(doc.status).toBe(200);expect(doc.data).toMatchObject({path:'reports/spec-analysis.md',content:'# Synthetic analysis'});expect(doc.data).not.toHaveProperty('aiGenerated');
 expect(service.planVersion(service.get(id))).toBe(before);
});
it('excludes hidden, non-Markdown, attachment, link, oversized and outside documents',async()=>{
 mkdirSync(join(docs,'.private'));writeFileSync(join(docs,'.private/secret.md'),'synthetic secret');writeFileSync(join(docs,'token.json'),'{}');
 mkdirSync(join(docs,'Attachments'));writeFileSync(join(docs,'Attachments/private.md'),'synthetic attachment');writeFileSync(join(docs,'huge.md'),'x'.repeat(2000001));
 const outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'spec.md'),'synthetic outside');symlinkSync(outside,join(docs,'linked'),'junction');linkSync(join(outside,'spec.md'),join(docs,'shared.md'));
 const list=(await get(`work/${id}`)).data.documents;for(const name of ['.private/secret.md','token.json','Attachments/private.md','huge.md','linked/spec.md','shared.md'])expect(list).not.toContain(name);
 for(const path of ['../outside/spec.md','.private/secret.md','linked/spec.md','shared.md','token.json','Attachments/private.md','huge.md'])expect((await get(`work/${id}/document?path=${encodeURIComponent(path)}`)).status).not.toBe(200);
});
it('keeps completed and archived document snapshots frozen instead of adding live reports',async()=>{
 const store=app.get(WorkStore),service=app.get(WorkService),original=structuredClone(service.get(id));
 const saved={path:'proposal.md',content:'# Frozen snapshot',version:'saved-version'};
 try{
  for(const phase of ['completed','archived'] as const){
   store.save({...original,phase,completedDocuments:{'proposal.md':saved}});
   expect((await get(`work/${id}`)).data.documents).toEqual(['proposal.md']);
   expect((await get(`work/${id}/document?path=proposal.md`)).data).toEqual(saved);
   expect((await get(`work/${id}/document?path=review-notes.md`)).status).toBe(404);
  }
 }finally{store.save(original);}
});
