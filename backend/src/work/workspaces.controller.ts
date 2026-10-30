import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, OnModuleDestroy, Param, Post, Query } from '@nestjs/common';
import { WorkService } from './work.service';
import { WorkStore } from './store';
import { WorkspaceSettingsService } from './workspace-settings.service';
import { WorkspaceProvisioner } from './workspace-provisioner';
import { WorkspaceService } from './workspace.service';
import { WorkspaceCleanup } from './workspace-cleanup';
import { DesktopLifecycle } from '../desktop/lifecycle';
@Controller('work/:id/workspace')
export class WorkspacesController implements OnModuleDestroy {
  private provisioner: WorkspaceProvisioner;
  private cleanup: WorkspaceCleanup;
  constructor(@Inject(WorkService) private works: WorkService, @Inject(WorkStore) store: WorkStore, @Inject(WorkspaceSettingsService) settings: WorkspaceSettingsService, @Inject(DesktopLifecycle) lifecycle: DesktopLifecycle) { this.provisioner = new WorkspaceProvisioner(store, settings); this.cleanup = new WorkspaceCleanup(store, settings, lifecycle); }
  @Get() status(@Param('id') id: string) { return this.provisioner.status(this.works.get(id)); }
  @Get('cleanup') cleanupStatus(@Param('id') id: string, @Query() query: Record<string, unknown> = {}) {
    if (Object.keys(query).some(key => key !== 'candidateId') || query.candidateId !== undefined && typeof query.candidateId !== 'string') throw new BadRequestException('정리할 후보 ID만 지정해 주세요');
    return this.cleanup.status(id, query.candidateId as string | undefined);
  }
  @Post('cleanup') @HttpCode(200) cleanupRemove(@Param('id') id: string, @Body() body: unknown, @Query() query: Record<string, unknown> = {}) {
    if (Object.keys(query).some(key => key !== 'candidateId') || query.candidateId !== undefined && typeof query.candidateId !== 'string') throw new BadRequestException('정리할 후보 ID만 지정해 주세요');
    return this.cleanup.remove(id, body, query.candidateId as string | undefined);
  }
  @Get('cleanup/preview') cleanupPreview(@Param('id') id: string, @Query() query: Record<string, unknown> = {}) {
    if (Object.keys(query).some(key => key !== 'candidateId') || query.candidateId !== undefined && typeof query.candidateId !== 'string') throw new BadRequestException('정리할 후보 ID만 지정해 주세요');
    return this.cleanup.preview(id, query.candidateId as string | undefined);
  }
  @Get('preview') preview(@Param('id') id: string, @Query('selectedBranch') selectedBranch?: string) { return this.provisioner.preview(this.works.get(id), selectedBranch); }
  @Post('prepare') @HttpCode(200) prepare(@Param('id') id: string, @Body() body: unknown) {
    const work = this.works.get(id);
    return this.provisioner.prepare(work, body, () => { if (!new WorkspaceService(this.works.store).hasSpace(work) && (!work.reviewedVersion || work.reviewedVersion !== this.works.planVersion(work))) throw new ConflictException('최신 문서 검토를 먼저 완료해 주세요.'); });
  }
  // An explicit retry uses the same durable request and actual ownership checks.
  // It cannot choose a new path or silently rerun failed local commands.
  @Post('recover') @HttpCode(200) recover(@Param('id') id: string, @Body() body: unknown) { return this.prepare(id, body); }
  async onModuleDestroy() { await this.provisioner.close(); }
}
