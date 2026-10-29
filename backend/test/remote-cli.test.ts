import { afterEach, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RemoteBridge } from '../src/remote/bridge';
const execute = promisify(execFile); let bridge: RemoteBridge | undefined;
afterEach(async () => { await bridge?.close(); });
it('CLI uses explicit discovery without printing credentials and supports durable mutation and polling', async () => {
 const directory=mkdtempSync(join(tmpdir(),'remote-cli-'));
 bridge=new RemoteBridge(directory,{list:()=>({work:[{id:'one'}]}),get:id=>({id}),execute:()=>({requested:true})},{locked:false,beginRequest:()=>()=>{}}); await bridge.start();
 const cli=resolve('scripts/board-remote.cjs');
 const call=(args:string[])=>execute(process.execPath,[cli,'--connection',bridge!.connectionPath,...args]);
 const list=await call(['list']); expect(JSON.parse(list.stdout)).toEqual({work:[{id:'one'}]});
 const result=await call(['message','one','--request-id','e9aa8854-fc40-4bb1-bcaf-6b12f025a558','--text','hello']); expect(JSON.parse(result.stdout)).toMatchObject({requestId:'e9aa8854-fc40-4bb1-bcaf-6b12f025a558'});
 const status=await call(['command-status','e9aa8854-fc40-4bb1-bcaf-6b12f025a558']); expect(JSON.parse(status.stdout)).toMatchObject({status:'completed'});
 expect(list.stdout+list.stderr+result.stdout+result.stderr+status.stdout).not.toContain(JSON.parse(readFileSync(bridge.connectionPath,'utf8')).secret);
 await expect(call(['message','one','--text','missing id'])).rejects.toMatchObject({code:1});
});
it('CLI help needs no connection descriptor and explains polling without credentials', async () => {
 const result=await execute(process.execPath,[resolve('scripts/board-remote.cjs'),'--help']);
 expect(result.stdout).toContain('--connection'); expect(result.stdout).toContain('command-status'); expect(result.stderr).toBe('');
});

it('CLI stdin preserves Korean JSON split in the middle of UTF8 bytes', async () => {
 let received: any;
 bridge=new RemoteBridge(mkdtempSync(join(tmpdir(),'remote-cli-utf8-')),{list:()=>({}),get:()=>({}),execute:(_action,_id,body)=>{received=body;return {ok:true};}},{locked:false,beginRequest:()=>()=>{}}); await bridge.start();
 const child=spawn(process.execPath,[resolve('scripts/board-remote.cjs'),'--connection',bridge.connectionPath,'message','one','--request-id','e9aa8854-fc40-4bb1-bcaf-6b12f025a558','--stdin'],{stdio:['pipe','pipe','pipe']});
 const completed=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('CLI exited '+code)));});
 child.stdout.resume(); child.stderr.resume();
 const bytes=Buffer.from(JSON.stringify({text:'한글 사용자 지시'})); const split=bytes.indexOf(Buffer.from('한'))+1;
 child.stdin.write(bytes.subarray(0,split)); await new Promise(resolve=>setTimeout(resolve,200)); child.stdin.end(bytes.subarray(split));
 await completed; expect(received).toEqual({text:'한글 사용자 지시'});
});
