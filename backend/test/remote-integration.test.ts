import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkController } from '../src/work/work.controller';
let app: INestApplication | undefined;
afterEach(async () => { await app?.close(); app = undefined; for (const key of ['DATA_DIR','CONFIG_PATH','DESKTOP_TOKEN']) delete process.env[key]; });
it('normal Board auth reports only launch paths; remote execution retains WorkController guards', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'remote-integration-')); process.env.DATA_DIR = join(dir,'data'); process.env.CONFIG_PATH = join(dir,'config.json'); process.env.DESKTOP_TOKEN = 'desktop-secret'; mkdirSync(join(dir,'openspec')); writeFileSync(process.env.CONFIG_PATH, JSON.stringify({sources:[{name:'empty',path:join(dir,'openspec')}]}));
 app = await createApplication(); await app.listen(0, '127.0.0.1');
 const url = await app.getUrl();
 expect((await fetch(url + '/api/remote')).status).toBe(401);
 const info = await (await fetch(url + '/api/remote', {headers:{'x-desktop-token':'desktop-secret'}})).json();
 expect(info).toMatchObject({available:true, transport:'loopback', mobileVerified:false});
 expect(info.connectionPath).toBe(join(dir,'data','remote-connection.json')); expect(JSON.stringify(info)).not.toContain('desktop-secret'); expect(info.secret).toBeUndefined();
 const descriptor = JSON.parse(readFileSync(info.connectionPath,'utf8'));
 expect(descriptor.secret).not.toBe('desktop-secret');
 const response = await fetch(descriptor.url + '/commands', {method:'POST', headers:{authorization:'Bearer '+descriptor.secret}, body:JSON.stringify({requestId:'e9aa8854-fc40-4bb1-bcaf-6b12f025a558',workId:'missing',action:'message',body:{text:'hello'}})});
 expect(response.status).toBe(202);
 let result: any;
 for (let i=0;i<50;i++) { result=await (await fetch(descriptor.url + '/commands/e9aa8854-fc40-4bb1-bcaf-6b12f025a558',{headers:{authorization:'Bearer '+descriptor.secret}})).json(); if(result.status==='failed') break; await new Promise(resolve=>setTimeout(resolve,5)); }
 expect(result).toMatchObject({status:'failed',errorStatus:404});
});
it('a corrupt remote command journal disables the bridge without preventing Board startup', async () => {
 const dir=mkdtempSync(join(tmpdir(),'remote-corrupt-')); process.env.DATA_DIR=join(dir,'data'); process.env.CONFIG_PATH=join(dir,'config.json'); mkdirSync(join(dir,'openspec')); mkdirSync(join(dir,'data','remote-commands'),{recursive:true}); writeFileSync(join(dir,'data','remote-commands','e9aa8854-fc40-4bb1-bcaf-6b12f025a558.json'),'{broken'); writeFileSync(process.env.CONFIG_PATH,JSON.stringify({sources:[{name:'empty',path:join(dir,'openspec')}]}));
 app=await createApplication(); await app.listen(0,'127.0.0.1');
 const url=await app.getUrl(); expect((await fetch(url+'/api/health')).status).toBe(200);
 expect(await (await fetch(url+'/api/remote')).json()).toMatchObject({available:false});
});
