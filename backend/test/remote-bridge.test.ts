import { request as httpRequest } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteBridge } from '../src/remote/bridge';

const bridges: RemoteBridge[] = [];
afterEach(async () => { for (const bridge of bridges.splice(0)) await bridge.close(); });
async function setup(execute: (action: string, id: string, body: any) => unknown = () => ({ ok: true }), dir = mkdtempSync(join(tmpdir(), 'board-remote-'))) {
  const lifecycle = { locked: false, requests: 0, beginRequest() { this.requests++; return () => { this.requests--; }; } };
  const bridge = new RemoteBridge(dir, { list: () => ({ work: [] }), get: id => ({ id }), execute }, lifecycle);
  bridges.push(bridge); await bridge.start();
  const descriptor = JSON.parse(readFileSync(bridge.connectionPath, 'utf8'));
  const call = (path: string, body?: unknown, headers: Record<string,string> = {}) => fetch(descriptor.url + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${descriptor.secret}`, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { bridge, descriptor, call, lifecycle, dir };
}
const request = (requestId = 'e9aa8854-fc40-4bb1-bcaf-6b12f025a558') => ({ requestId, workId: 'one', action: 'message', body: { text: 'hello' } });
async function terminal(call: any, id: string) { for (let i = 0; i < 50; i++) { const row = await (await call(`/commands/${id}`)).json(); if (!['accepted','running'].includes(row.status)) return row; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('command never completed'); }
it('binds loopback and rejects missing credentials and every browser Origin', async () => {
  const { descriptor, call } = await setup();
  expect(new URL(descriptor.url).hostname).toBe('127.0.0.1');
  expect((await call('/work', undefined, { authorization: '' })).status).toBe(401);
  expect((await call('/work', undefined, { authorization: 'Bearer wrong' })).status).toBe(401);
  expect((await call('/work', undefined, { origin: 'http://localhost:13002' })).status).toBe(403);
  expect((await call('/work')).status).toBe(200);
});
it('acknowledges once, fingerprints retries, and holds lifecycle while execution continues', async () => {
  let release!: () => void; let runs = 0;
  const { call, lifecycle } = await setup(async () => { runs++; await new Promise<void>(resolve => { release = resolve; }); return { ok: true }; });
  const command = request();
  expect((await call('/commands', command)).status).toBe(202);
  expect(lifecycle.requests).toBe(1);
  expect((await call('/commands', command)).status).toBe(202);
  expect((await call('/commands', { ...command, body: { text: 'different' } })).status).toBe(409);
  lifecycle.locked = true;
  expect((await call('/work/one')).status).toBe(200);
  expect((await call('/commands', request('9b179f3e-1de0-40d3-bf19-350fdb3964bb'))).status).toBe(409);
  release(); expect((await terminal(call, command.requestId)).status).toBe('completed');
  expect(runs).toBe(1); expect(lifecycle.requests).toBe(0);
});
it('retains failures and never repeats completed or interrupted-by-restart commands', async () => {
  let runs = 0;
  const first = await setup(() => { runs++; throw Object.assign(Error('guard denied'), { getStatus: () => 409 }); });
  const command = request(); await first.call('/commands', command);
  expect((await terminal(first.call, command.requestId)).status).toBe('failed');
  await first.bridge.close();
  const file = join(first.dir, 'remote-commands', command.requestId + '.json');
  const row = JSON.parse(readFileSync(file, 'utf8')); row.status = 'running'; writeFileSync(file, JSON.stringify(row));
  const second = await setup(() => { runs++; }, first.dir);
  expect((await (await second.call(`/commands/${command.requestId}`)).json()).status).toBe('uncertain');
  await second.call('/commands', command); expect(runs).toBe(1);
});
it('rejects malformed identifiers, oversized content and implicit question recovery', async () => {
  const { call } = await setup();
  expect((await call('/commands', { ...request(), requestId: '../bad' })).status).toBe(400);
  expect((await call('/commands', { ...request(), body: { text: 'x'.repeat(70000) } })).status).toBe(413);
  expect((await call('/commands', { ...request(), action: 'answer', body: { questionId: 'q', generation: 1, answers: {}, recover: true } })).status).toBe(400);
});
it('accepts actual generation-prefixed question IDs and opaque generation versions', async () => {
  const { call } = await setup();
  expect((await call('/commands', { ...request(), action: 'approval', body: { questionId: 'generation-uuid:42', generation: 'generation-uuid', decision: 'decline' } })).status).toBe(202);
});
it('UUID letter case cannot execute the same command twice on Windows', async () => {
 let runs=0; const {call}=await setup(()=>{runs++;}); const command=request();
 await call('/commands',command); await terminal(call,command.requestId);
 await call('/commands',{...command,requestId:command.requestId.toUpperCase()});
 expect(runs).toBe(1);
});
it('another live bridge cannot overwrite connection discovery', async () => {
 const first=await setup();
 const before=readFileSync(first.bridge.connectionPath,'utf8');
 const second=new RemoteBridge(first.dir,{list:()=>({}),get:()=>({}),execute:()=>({})},{locked:false,beginRequest:()=>()=>{}}); bridges.push(second);
 await expect(second.start()).rejects.toThrow();
 expect(readFileSync(first.bridge.connectionPath,'utf8')).toBe(before);
});

it('preserves Korean instructions when UTF8 characters cross HTTP chunks', async () => {
 const {descriptor,call}=await setup((_action,_id,body)=>({text:body.text}));
 const command={...request(),body:{text:'한글 지시'}};
 const body=Buffer.from(JSON.stringify(command)); const position=body.indexOf(Buffer.from('한'))+1;
 await new Promise<void>((resolve,reject)=>{
  const req=httpRequest(descriptor.url+'/commands',{method:'POST',headers:{authorization:'Bearer '+descriptor.secret,'content-length':body.length}},res=>{res.resume();res.on('end',()=>resolve());});
  req.on('error',reject);req.write(body.subarray(0,position));setTimeout(()=>req.end(body.subarray(position)),10);
 });
 expect((await terminal(call,command.requestId)).result).toEqual({text:'한글 지시'});
});
it('recovery cancellation preserves the original recovery ID separately from the command ID', async () => {
 let received: any;
 const {call}=await setup((action,id,body)=>{received={action,id,body};return {status:'abandoned'};});
 const command={...request(),action:'cancel-session-recovery',body:{requestId:'9b179f3e-1de0-40d3-bf19-350fdb3964bb'}};
 expect((await call('/commands',command)).status).toBe(202);
 expect((await terminal(call,command.requestId)).status).toBe('completed');
 expect(received).toEqual({action:'cancel-session-recovery',id:'one',body:{requestId:'9b179f3e-1de0-40d3-bf19-350fdb3964bb'}});
 expect((await call('/commands',{...command,requestId:'b7fb7c74-b87c-45a9-89f1-6ca962ceab80',body:{requestId:'bad'}})).status).toBe(400);
});
