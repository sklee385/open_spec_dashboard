import { BadRequestException, ConflictException, Body, Post, HttpCode, Controller, Get, Header, Inject, Optional, Param, Query, StreamableFile } from '@nestjs/common';
import { WorkStore } from './store';
import { CompletedResults } from './completed-results';
import { WorkspaceSettingsService } from './workspace-settings.service';
@Controller('work/:id/completion')
export class CompletedResultsController {
  constructor(@Inject(WorkStore) private readonly store:WorkStore, @Optional() @Inject(WorkspaceSettingsService) private readonly settings?:WorkspaceSettingsService) {}
  private query(query:Record<string,unknown>,keys:string[]) {
    if(Object.keys(query).some(key=>!keys.includes(key))||typeof query.captureId!=='string'||!/^[a-f0-9-]{36}$/.test(query.captureId))throw new BadRequestException('보존 캡처와 조회 범위를 확인해 주세요');
    return query.captureId;
  }
  private number(value:unknown,fallback:number) { if(value===undefined)return fallback;if(typeof value!=='string'||!/^\d{1,5}$/.test(value))throw new BadRequestException('보존 조회 번호를 확인해 주세요');return Number(value); }
  @Get() header(@Param('id')id:string,@Query()query:Record<string,unknown>={}) { const reader=new CompletedResults(this.store);if(!Object.keys(query).length)return reader.header(id);return reader.header(id,this.query(query,['captureId'])); }
  @Get('files') files(@Param('id')id:string,@Query()query:Record<string,unknown>) { const captureId=this.query(query,['captureId','after','limit']);return new CompletedResults(this.store).files(id,captureId,this.number(query.after,0),this.number(query.limit,25)); }
  @Get('file') file(@Param('id')id:string,@Query()query:Record<string,unknown>) { const captureId=this.query(query,['captureId','ordinal']);if(query.ordinal===undefined)throw new BadRequestException('파일 번호가 필요합니다');return new CompletedResults(this.store).file(id,captureId,this.number(query.ordinal,0)); }
  @Get('verifications') verifications(@Param('id')id:string,@Query()query:Record<string,unknown>) { const captureId=this.query(query,['captureId','after','limit']);return new CompletedResults(this.store).verifications(id,captureId,this.number(query.after,0),this.number(query.limit,25),this.settings?.read().policy.retentionDays??14); }
  @Get('evidence/:evidenceId/cleanup') evidenceCleanup(@Param('id')id:string,@Param('evidenceId')evidenceId:string,@Query()query:Record<string,unknown>) {
    const captureId=this.query(query,['captureId']),settings=this.settings?.read();return {...new CompletedResults(this.store).evidenceCleanup(id,captureId,evidenceId,settings?.policy.retentionDays??14),policyVersion:settings?.version??null};
  }
  @Post('evidence/:evidenceId/expire') @HttpCode(200) expire(@Param('id')id:string,@Param('evidenceId')evidenceId:string,@Body()input:unknown) {
    const body=input as any;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==5||Object.keys(body).some(key=>!['captureId','expectedHash','policyVersion','confirmed','requestKey'].includes(key))||body.confirmed!==true||typeof body.captureId!=='string'||!/^[a-f0-9-]{36}$/.test(body.captureId)||typeof body.expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(body.expectedHash)||typeof body.requestKey!=='string'||!/^[a-f0-9-]{36}$/.test(body.requestKey)||!Number.isSafeInteger(body.policyVersion))throw new BadRequestException('정확한 화면·보존 정책·삭제 확인이 필요합니다');
    if(!this.settings)throw new ConflictException('보존 정책을 확인할 수 없습니다');
    const reader=new CompletedResults(this.store);
    return this.settings.withSelectedRoot(settings=>{
      const row=reader.evidenceCleanup(id,body.captureId,evidenceId,settings.policy.retentionDays);
      if(row.expectedHash!==body.expectedHash)throw new ConflictException('보존 자료가 변경되었습니다');
      if(row.state==='expired')return {...row,status:'expired'};
      if(settings.version!==body.policyVersion||!row.eligibleForCleanup)throw new ConflictException('보존 기간·정책을 다시 확인해 주세요');
      this.store.transaction(()=>reader.expireEvidence(id,body.captureId,evidenceId,{confirmed:true,expectedHash:body.expectedHash}));
      return {...reader.evidenceCleanup(id,body.captureId,evidenceId,settings.policy.retentionDays),status:'expired'};
    });
  }
  @Get('evidence/:evidenceId') @Header('Cache-Control','no-store') image(@Param('id')id:string,@Param('evidenceId')evidenceId:string,@Query()query:Record<string,unknown>) { const captureId=this.query(query,['captureId']),bytes=new CompletedResults(this.store).image(id,captureId,evidenceId);return new StreamableFile(bytes,{type:'image/jpeg',length:bytes.length}); }
}