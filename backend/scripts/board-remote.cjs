#!/usr/bin/env node
'use strict';
// Credentials stay in the local descriptor and HTTP header, never in argv or output.
const { readFileSync } = require('node:fs');
const { isAbsolute } = require('node:path');
const { request } = require('node:http');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function main() {
 const argv = process.argv.slice(2), options = {}, positional = [];
 if(argv.length===1 && ['--help','-h'].includes(argv[0])) { process.stdout.write('Board remote: --connection <absolute descriptor path> list | status <workId> | command-status <UUID> | message/answer/approval/interrupt/reconnect/recover-session/cancel-session-recovery <workId> --request-id <UUID> [--stdin | --json bodyJSON | --text message]\nMutations acknowledge acceptance. Poll command-status with the same UUID; never automatically resubmit after a timeout.\n'); return; }
 for (let i=0;i<argv.length;i++) {
  const arg=argv[i];
  if (arg === '--stdin') { if(options.stdin) throw Error('중복 옵션입니다'); options.stdin=true; }
  else if(arg.startsWith('--')) {
   if(!['--connection','--request-id','--text','--json'].includes(arg) || options[arg]!==undefined || i+1>=argv.length) throw Error('올바른 CLI 옵션이 필요합니다');
   options[arg]=argv[++i];
  } else positional.push(arg);
 }
 if(!isAbsolute(options['--connection'] || '')) throw Error('--connection 절대 경로가 필요합니다');
 let descriptor; try { descriptor=JSON.parse(readFileSync(options['--connection'],'utf8')); } catch { throw Error('연결 파일을 읽을 수 없습니다. Board 연결 정보를 다시 확인해 주세요'); }
 let url; try { url=new URL(descriptor.url); } catch { throw Error('올바른 연결 파일이 필요합니다'); }
 if(descriptor.version!==1 || url.protocol!=='http:' || url.hostname!=='127.0.0.1' || !url.port || url.username || url.password || url.pathname!=='/' || url.search || url.hash || !/^[a-f0-9]{64}$/.test(descriptor.secret)) throw Error('로컬 연결 파일 형식이 올바르지 않습니다');
 const [command,id]=positional; let path, payload;
 if(command==='list' && positional.length===1) path='/work';
 else if(command==='status' && positional.length===2 && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id)) path='/work/'+id;
 else if(command==='command-status' && positional.length===2 && uuid.test(id)) path='/commands/'+id;
 else if(['message','answer','approval','interrupt','reconnect','recover-session','cancel-session-recovery'].includes(command) && positional.length===2) {
  if(!uuid.test(options['--request-id'] || '')) throw Error('변경 명령에는 --request-id UUID가 필요합니다. 시간 초과 시 이 ID로 command-status를 조회해 주세요');
  if([options.stdin,options['--json']!==undefined,options['--text']!==undefined].filter(Boolean).length>1) throw Error('--stdin, --json, --text 중 하나만 사용해 주세요');
  let body={};
  if(options.stdin) {
   const chunks=[]; let bytes=0; for await(const chunk of process.stdin) { bytes+=chunk.length; if(bytes>65536) throw Error('입력은 64KiB 이하여야 합니다'); chunks.push(chunk); }
   const input=Buffer.concat(chunks).toString('utf8');
   try { body=JSON.parse(input); } catch { throw Error('stdin에 body JSON이 필요합니다'); }
  } else if(options['--json']!==undefined) { try { body=JSON.parse(options['--json']); } catch { throw Error('--json에 body JSON이 필요합니다'); } }
  else if(options['--text']!==undefined) body={text:options['--text']};
  payload=JSON.stringify({requestId:options['--request-id'],workId:id,action:command,body});
  if(Buffer.byteLength(payload)>65536) throw Error('입력은 64KiB 이하여야 합니다');
  path='/commands';
 } else throw Error('명령: list | status 업무ID | command-status 명령UUID | message/answer/approval/interrupt/reconnect/recover-session/cancel-session-recovery 업무ID --request-id UUID [--stdin | --json bodyJSON | --text 메시지]');
 const response=await new Promise((resolve,reject)=>{
  const req=request(new URL(path,url),{method:payload?'POST':'GET',headers:{authorization:'Bearer '+descriptor.secret,...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{})}},res=>{
   let data=''; res.setEncoding('utf8'); res.on('data',chunk=>{data+=chunk; if(Buffer.byteLength(data)>16*1024*1024) req.destroy(Error('응답이 너무 큽니다'));});
   res.on('end',()=>{ try { const body=JSON.parse(data); if(res.statusCode>=400) reject(Error(typeof body.error==='string'?body.error:'Board 요청이 거부되었습니다')); else resolve(body); } catch { reject(Error('Board 응답을 읽을 수 없습니다')); } });
  });
  req.setTimeout(10000,()=>req.destroy(Error('연결 시간 초과. 명령을 다시 보내기 전에 같은 ID로 command-status를 조회해 주세요')));
  req.on('error',error=>reject(Error(error.message?.startsWith('연결 시간 초과')?error.message:'로컬 Board 연결에 실패했습니다. 명령 상태를 확인한 뒤 재시도해 주세요')));
  req.end(payload);
 });
 process.stdout.write(JSON.stringify(response,null,2)+'\n');
}
main().catch(error=>{process.stderr.write(JSON.stringify({error:error.message})+'\n');process.exitCode=1;});
