import { BadRequestException, Controller, Get, Header, Inject, Optional, Param, Query, StreamableFile } from '@nestjs/common';
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
  @Get('evidence/:evidenceId') @Header('Cache-Control','no-store') image(@Param('id')id:string,@Param('evidenceId')evidenceId:string,@Query()query:Record<string,unknown>) { const captureId=this.query(query,['captureId']),bytes=new CompletedResults(this.store).image(id,captureId,evidenceId);return new StreamableFile(bytes,{type:'image/jpeg',length:bytes.length}); }
}