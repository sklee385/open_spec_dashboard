const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
async function createPortableManifest({version,zipFile,destination}) {
  const expected=`OpenSpecBoard-${version}-win-x64-portable.zip`;
  if(path.basename(zipFile)!==expected)throw new Error('무설치 ZIP 버전·이름 불일치');
  const hash=createHash('sha512');for await(const chunk of fs.createReadStream(zipFile))hash.update(chunk);
  const value={version,file:expected,size:fs.statSync(zipFile).size,sha512:hash.digest('base64')};
  require('../desktop/portable-updater.cjs').validatePortableManifest(value,version);
  fs.writeFileSync(destination,JSON.stringify(value,null,2));return value;
}
async function buildPortable(){
  const version=require('../package.json').version;
  const stageName='desktop-stage-portable';
  const output=path.join(root,'.tools/desktop-dist-portable');
  const env={...process.env,DESKTOP_STAGE_NAME:stageName,DESKTOP_PORTABLE_BUILD:'1'};
  const run=args=>{const result=spawnSync(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:'inherit'});if(result.status!==0)throw new Error('무설치 빌드 실패');};
  run([path.join(__dirname,'desktop-stage.cjs'),'--portable',...(process.env.DESKTOP_RELEASE==='1'?['--release']:[])]);
  const filename=`OpenSpecBoard-${version}-win-x64-portable.zip`;
  run([require.resolve('electron-builder/cli.js'),'--config','desktop/electron-builder.cjs','--win','zip','--x64','--publish','never',`--config.directories.output=${output}`,`--config.artifactName=${filename}`]);
  const releaseName=process.env.DESKTOP_RELEASE_OUTPUT || 'desktop-dist';
  if(!/^desktop-dist(?:-[a-z0-9]+)*$/.test(releaseName))throw new Error('잘못된 배포 출력 이름');
  const release=path.join(root,'.tools',releaseName);
  fs.mkdirSync(release,{recursive:true});
  const zipFile=path.join(release,filename);fs.copyFileSync(path.join(output,filename),zipFile);
  await createPortableManifest({version,zipFile,destination:path.join(release,'portable.json')});
  require('../desktop/artifacts.cjs').validateArtifacts(release,version);
  console.log('무설치 ZIP·portable.json 및 설치형 호환 산출물 검증 완료');
}
module.exports={createPortableManifest};
if(require.main===module)buildPortable().catch(error=>{console.error(error.message);process.exitCode=1;});
