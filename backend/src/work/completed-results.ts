import { BadRequestException, ConflictException, GoneException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { WorkStore, type Work } from './store';
import { managedPrivatePath } from './workspace-file-policy';
import { inspectWorkspacePath } from './workspace-paths';

type Ref = { id: string; kind: 'verification' | 'candidate-verification' | 'browser-verification' };
export type CompletedIntegration = { candidateId?: string; targetBranch?: string; appliedCommit?: string; resultCommit?: string };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const canon = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const bounded = (value: unknown, maximum: number) => { const text = JSON.stringify(value); if (Buffer.byteLength(text) > maximum) throw new PayloadTooLargeException('완료 보존 자료 한도를 초과했습니다'); return text; };
export class CompletedResults {
  constructor(private store: WorkStore) {}
  private exists() { return !!this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='completion_captures'").get(); }
  private schema() { this.store.db.exec(`
    CREATE TABLE IF NOT EXISTS completion_captures(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES work(id),metadata TEXT NOT NULL,file_count INTEGER NOT NULL DEFAULT 0,verification_count INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS completion_owner ON completion_captures(work_id);
    CREATE TABLE IF NOT EXISTS completion_files(capture_id TEXT NOT NULL REFERENCES completion_captures(id),ordinal INTEGER NOT NULL,metadata TEXT NOT NULL,before_text TEXT,after_text TEXT,PRIMARY KEY(capture_id,ordinal));
    CREATE TABLE IF NOT EXISTS completion_verifications(capture_id TEXT NOT NULL REFERENCES completion_captures(id),ordinal INTEGER NOT NULL,metadata TEXT NOT NULL,image_id TEXT,PRIMARY KEY(capture_id,ordinal));
    CREATE TABLE IF NOT EXISTS completion_images(capture_id TEXT NOT NULL REFERENCES completion_captures(id),id TEXT NOT NULL,bytes BLOB,sha256 TEXT,created_at TEXT NOT NULL,expired_at TEXT,PRIMARY KEY(capture_id,id));
  `); }
  header(workId: string, captureId?: string): any | null {
    if (!this.store.get(workId)) throw new NotFoundException('보존 업무가 없습니다');
    if (!this.exists()) return null;
    const row = (captureId ? this.store.db.prepare('SELECT * FROM completion_captures WHERE work_id=? AND id=?').get(workId,captureId) : this.store.db.prepare('SELECT * FROM completion_captures WHERE work_id=? ORDER BY rowid DESC LIMIT 1').get(workId)) as any;
    if (!row) return null;
    return { ...JSON.parse(row.metadata), files: [], retained: { workId, captureId: row.id, fileCount: row.file_count, verificationCount: row.verification_count, ...(JSON.parse(row.metadata).integration ? { integration: JSON.parse(row.metadata).integration } : {}) } };
  }
  private owner(workId: string, captureId: string) { const header = this.header(workId,captureId); if (!header) throw new NotFoundException('해당 업무의 완료 캡처가 없습니다'); return header; }
  private page(after: number, limit: number) { if (!Number.isSafeInteger(after) || after < 0 || after > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException('완료 자료의 페이지 범위를 확인해 주세요'); }
  files(workId: string,captureId: string,after=0,limit=25) {
    const header = this.owner(workId,captureId); this.page(after,limit);
    const rows = this.store.db.prepare('SELECT metadata FROM completion_files WHERE capture_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?').all(captureId,after,limit) as {metadata:string}[];
    const files = rows.map(row=>JSON.parse(row.metadata)), next = after + files.length;
    return {workId,captureId,files,nextCursor:next<header.retained.fileCount?next:null};
  }
  file(workId: string,captureId: string,ordinal: number) {
    this.owner(workId,captureId); this.page(ordinal,1);
    const row = this.store.db.prepare('SELECT metadata,before_text,after_text FROM completion_files WHERE capture_id=? AND ordinal=?').get(captureId,ordinal) as any;
    if (!row) throw new NotFoundException('보존 파일이 없습니다');
    return {...JSON.parse(row.metadata),before:row.before_text,after:row.after_text};
  }
  verifications(workId: string,captureId: string,after=0,limit=25,retentionDays=14) {
    const header=this.owner(workId,captureId); this.page(after,limit); if(!Number.isSafeInteger(retentionDays)||retentionDays<1)throw new ConflictException('검증 자료 보존 기간 설정을 확인해 주세요');
    const rows=this.store.db.prepare('SELECT v.metadata,v.image_id,i.sha256,i.expired_at,i.created_at FROM completion_verifications v LEFT JOIN completion_images i ON i.capture_id=v.capture_id AND i.id=v.image_id WHERE v.capture_id=? AND v.ordinal>=? ORDER BY v.ordinal LIMIT ?').all(captureId,after,limit) as any[];
    const results=rows.map(row=>({...JSON.parse(row.metadata),...(row.image_id?{evidence:{id:row.image_id,state:row.expired_at?'expired':row.sha256?'available':'missing',eligibleForCleanup:!row.expired_at&&!!row.sha256&&Date.now()>=Date.parse(row.created_at)+retentionDays*86400000,...(!row.expired_at&&row.sha256?{url:`/api/work/${encodeURIComponent(workId)}/completion/evidence/${encodeURIComponent(row.image_id)}?captureId=${encodeURIComponent(captureId)}`}:{})}}:{})}));
    return {workId,captureId,results,nextCursor:after+results.length<header.retained.verificationCount?after+results.length:null};
  }
  image(workId: string,captureId: string,id: string) {
    this.owner(workId,captureId); const row=this.store.db.prepare('SELECT bytes,sha256,expired_at FROM completion_images WHERE capture_id=? AND id=?').get(captureId,id) as any;
    if(row?.expired_at)throw new GoneException('검증 화면의 보존 자료가 만료됐습니다');
    if(!row?.bytes||!row.sha256)throw new NotFoundException('보존한 검증 화면이 없습니다');
    const bytes=Buffer.from(row.bytes);if(hash(bytes)!==row.sha256)throw new ConflictException('보존 증거의 무결성을 확인할 수 없습니다');return bytes;
  }
  /** Internal confirmed cleanup hook; age alone never deletes a retained image. */
  expireEvidence(workId:string,captureId:string,id:string,input:{confirmed:true;expectedHash:string}) {
    this.owner(workId,captureId);if(input?.confirmed!==true||!/^[a-f0-9]{64}$/.test(input.expectedHash))throw new BadRequestException('확인한 보존 자료가 필요합니다');
    const changed=this.store.db.prepare('UPDATE completion_images SET bytes=NULL,expired_at=? WHERE capture_id=? AND id=? AND sha256=? AND expired_at IS NULL').run(new Date().toISOString(),captureId,id,input.expectedHash);
    if(!changed.changes)throw new ConflictException('자료가 변경됐거나 이미 만료됐습니다');
  }
  private imageBytes(row:any):Buffer|null {
    if(!uuid(row.id)||!uuid(row.environmentId))return null;
    const expected=join(resolve(process.env.DATA_DIR||'../.data'),'verification-environments',row.environmentId,'evidence',row.id+'.jpg');
    if(typeof row.evidencePath!=='string'||canon(row.evidencePath)!==canon(expected))return null;
    try {
      inspectWorkspacePath(join(expected,'..'),[]);const before=lstatSync(expected);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>1024**2)return null;
      const fd=openSync(expected,'r');let bytes:Buffer;
      try {const opened=fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino||opened.nlink!==1)return null;const parts:Buffer[]=[];let size=0;while(true){const part=Buffer.allocUnsafe(8192),count=readSync(fd,part,0,part.length,null);if(!count)break;size+=count;if(size>1024**2)return null;parts.push(part.subarray(0,count));}bytes=Buffer.concat(parts,size);}finally{closeSync(fd);}
      const after=lstatSync(expected);if(after.dev!==before.dev||after.ino!==before.ino||after.nlink!==1||after.size!==bytes.length||after.mtimeMs!==before.mtimeMs)return null;return bytes;
    }catch{return null;}
  }
  workRefs(work:Work):Ref[] {
    const refs:Ref[]=[];const commands=Array.isArray(work.completedCommands)?work.completedCommands:Array.isArray(work.verificationCommands)?work.verificationCommands:[];
    if(commands.length>256)throw new PayloadTooLargeException('완료 검증 요약 한도를 초과했습니다');
    for(const command of commands){const row=this.store.db.prepare("SELECT id FROM records WHERE work_id=? AND kind='verification' AND json_extract(data,'$.commandId')=? AND json_extract(data,'$.scope')='full' ORDER BY rowid DESC LIMIT 1").get(work.id,command.id) as any;if(row)refs.push({id:row.id,kind:'verification'});}
    if(work.browserScenario){const row=this.store.db.prepare("SELECT id FROM records WHERE work_id=? AND kind='browser-verification' AND json_extract(data,'$.candidateId') IS NULL ORDER BY rowid DESC LIMIT 1").get(work.id) as any;if(row)refs.push({id:row.id,kind:'browser-verification'});}
    return refs;
  }
  capture(work:Work,report:any,refs:Ref[]=this.workRefs(work),integration?:CompletedIntegration):any {
    this.schema();const id=randomUUID(),point='completed_'+id.replaceAll('-','');this.store.db.exec('SAVEPOINT '+point);
    try {
      const metadata={version:1,policyVersion:report.policyVersion??1,workId:work.id,source:'completed',isolated:true,startedAt:report.startedAt??null,endedAt:report.endedAt??new Date().toISOString(),revision:report.revision,application:report.application,excluded:report.excluded??[],...(report.kind?{kind:report.kind}:{}),...(report.baseCommit?{baseCommit:report.baseCommit}:{}),...(integration?{integration}: {})};
      this.store.db.prepare('INSERT INTO completion_captures(id,work_id,metadata) VALUES(?,?,?)').run(id,work.id,bounded(metadata,65536));
      let fileCount=0,total=0;const paths=new Set<string>(),insert=this.store.db.prepare('INSERT INTO completion_files(capture_id,ordinal,metadata,before_text,after_text) VALUES(?,?,?,?,?)');
      for(const file of report.files){
        const path=file.path;if(typeof path!=='string'||!path||path.length>4096||isAbsolute(path)||/[\\\0:]/.test(path)||path.split('/').some((part:string)=>!part||part==='.'||part==='..')||managedPrivatePath(path)||paths.has(process.platform==='win32'?path.toLowerCase():path))throw new ConflictException('완료 파일의 경계·중복 또는 제외 정책을 확인해 주세요');
        paths.add(process.platform==='win32'?path.toLowerCase():path);if(++fileCount>10000)throw new PayloadTooLargeException('완료 파일 수 한도를 초과했습니다');
        for(const side of ['before','after']){const value=file[side];if(value!==null&&typeof value!=='string')throw new ConflictException('완료 파일 본문이 올바르지 않습니다');if(value!==null){const size=Buffer.byteLength(value);total+=size;if(size>=200000||total>128*1024**2)throw new PayloadTooLargeException('완료 본문 보존 한도를 초과했습니다');if(hash(value)!==file[side+'Hash'])throw new ConflictException('완료 파일 내용과 해시가 다릅니다');}}
        const {before,after,...info}=file;insert.run(id,fileCount-1,bounded({...info,ordinal:fileCount-1},16384),before,after);
      }
      if(refs.length>256)throw new PayloadTooLargeException('완료 검증 요약 한도를 초과했습니다');let verificationCount=0;const seen=new Set<string>();
      for(const ref of refs){
        if(seen.has(ref.id))continue;seen.add(ref.id);if(!['verification','candidate-verification','browser-verification'].includes(ref.kind))throw new ConflictException('검증 요약 종류를 확인해 주세요');
        const row=this.store.db.prepare("SELECT id,kind,json_extract(data,'$.status') status,json_extract(data,'$.targetKind') targetKind,json_extract(data,'$.commandId') commandId,json_extract(data,'$.candidateId') candidateId,json_extract(data,'$.environmentId') environmentId,json_extract(data,'$.evidencePath') evidencePath,json_extract(data,'$.createdAt') createdAt,json_extract(data,'$.freshnessEvidence.executedCommit') executedCommit,json_extract(data,'$.basis.candidateCommit') candidateCommit FROM records WHERE id=? AND work_id=? AND kind=?").get(ref.id,work.id,ref.kind) as any;
        if(!row)throw new ConflictException('완료 검증 근거가 없어 보존을 중단합니다');
        const summary={ordinal:verificationCount,id:row.id,kind:row.kind,status:row.status,targetKind:row.targetKind??(row.candidateId?'integration-candidate':'work'),...(row.commandId?{commandId:row.commandId}:{}),...(row.candidateId?{candidateId:row.candidateId}:{}),...(row.executedCommit||row.candidateCommit?{commit:row.executedCommit??row.candidateCommit}:{})};
        const imageId=ref.kind==='browser-verification'?row.id:null;
        if(imageId){const bytes=this.imageBytes(row),created=Date.parse(row.createdAt),createdAt=new Date(Number.isFinite(created)?created:Date.now()).toISOString();this.store.db.prepare('INSERT INTO completion_images(capture_id,id,bytes,sha256,created_at) VALUES(?,?,?,?,?)').run(id,imageId,bytes,bytes?hash(bytes):null,createdAt);}
        this.store.db.prepare('INSERT INTO completion_verifications(capture_id,ordinal,metadata,image_id) VALUES(?,?,?,?)').run(id,verificationCount++,bounded(summary,16384),imageId);
      }
      this.store.db.prepare('UPDATE completion_captures SET file_count=?,verification_count=? WHERE id=?').run(fileCount,verificationCount,id);const result=this.header(work.id,id)!;this.store.db.exec('RELEASE '+point);return result;
    }catch(error){this.store.db.exec('ROLLBACK TO '+point);this.store.db.exec('RELEASE '+point);throw error;}
  }
}