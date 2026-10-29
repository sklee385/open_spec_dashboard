const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname,'..');
const profile = fs.mkdtempSync(path.join(root,'.tools','desktop-force-smoke-'));
let binary = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : path.join(root,'.tools','desktop-dist','win-unpacked','OpenSpecBoard.exe');
if (process.argv.includes('--copy-to-temp')) {
  const target = fs.mkdtempSync(path.join(require('node:os').tmpdir(),'OpenSpecBoard-force-smoke-'));
  fs.cpSync(path.dirname(binary),path.join(target,'app'),{recursive:true}); binary=path.join(target,'app',path.basename(binary));
}
function run(extra) {
  return new Promise((resolve,reject) => {
    const child=spawn(binary,['--desktop-smoke-test','--desktop-health-test',...extra],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DESKTOP_SMOKE_DIRECTORY:profile}});
    let output='',errors='';child.stdout.on('data',data=>{output+=data});child.stderr.on('data',data=>{errors=(errors+data).slice(-4000)});
    const timer=setTimeout(()=>reject(Error('격리 강제 종료 검사 시간 초과; 이 검사 프로필만 확인해 주세요: '+profile)),90000);timer.unref();
    child.once('error',error=>{clearTimeout(timer);reject(error)});
    child.once('exit',code=>{clearTimeout(timer);resolve({code,output,errors})});
  });
}
(async()=>{
  const first=await run(['--desktop-force-test']);
  if(first.code===0||!first.output.includes('DESKTOP_FORCE_READY'))throw Error('격리 강제 종료 실패: '+first.errors);
  const marker=JSON.parse(fs.readFileSync(path.join(profile,'recovery-state.json'),'utf8'));
  if(!marker.unclean||!marker.safeMode)throw Error('비정상 종료·안전 시작 표시 누락');
  const owner=JSON.parse(fs.readFileSync(path.join(profile,'desktop-owner.json'),'utf8'));
  const helper=require(path.join(path.dirname(binary),'resources','emergency','emergency.cjs'));
  const processes=await helper.runProcessTool({action:'snapshot'});
  for(const identity of [owner.main,owner.service])if(processes.some(item=>item.pid===identity.pid&&item.createdAt===identity.createdAt))throw Error('격리한 앱 또는 서비스가 아직 실행 중입니다');
  const db=new DatabaseSync(path.join(profile,'data','work.sqlite'),{readOnly:true});
  if(Object.values(db.prepare('PRAGMA quick_check').get())[0]!=='ok')throw Error('강제 종료 후 DB 무결성 실패');db.close();
  const fixture=JSON.parse(fs.readFileSync(path.join(profile,'.desktop-force-smoke.json'),'utf8'));
  const reserved=require('node:net').createServer();
  await new Promise((resolve,reject)=>{reserved.once('error',reject);reserved.listen(Number(new URL(fixture.origin).port),'127.0.0.1',resolve)});
  let second;
  try { second=await run([`--desktop-post-force-test=${owner.nonce}`]); }
  finally { await new Promise(resolve=>reserved.close(resolve)); }
  if(second.code!==0||!second.output.includes('DESKTOP_POST_FORCE_READY')||!second.output.includes('DESKTOP_SMOKE_READY'))throw Error('강제 종료 후 재시작 검사 실패: '+second.errors);
  const backups=path.join(profile,'backups');
  const backupDb=fs.existsSync(backups)&&fs.readdirSync(backups,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>path.join(backups,entry.name,'data','work.sqlite')).find(file=>fs.existsSync(file)&&fs.statSync(file).size>0);
  if(!backupDb)throw Error('재시작 후 정상 백업 누락');
  const backup=new DatabaseSync(backupDb,{readOnly:true});
  if(Object.values(backup.prepare('PRAGMA quick_check').get())[0]!=='ok')throw Error('정상 백업 DB 무결성 실패');backup.close();
  console.log('격리 패키지 강제 종료·앱/서비스 종료 확인·SQLite 무결성·동일 프로필 안전 시작·다른 gateway origin 초안 복원·정상 백업 통과: '+profile);
})().catch(error=>{console.error(error.message);process.exitCode=1});
