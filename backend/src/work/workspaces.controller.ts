import { Body, ConflictException, Controller, Get, HttpCode, Inject, OnModuleDestroy, Param, Post, Query } from '@nestjs/common';
import { WorkService } from './work.service';
import { WorkStore } from './store';
import { WorkspaceSettingsService } from './workspace-settings.service';
import { WorkspaceProvisioner } from './workspace-provisioner';
import { WorkspaceService } from './workspace.service';
@Controller('work/:id/workspace')
export class WorkspacesController implements OnModuleDestroy {
  private provisioner: WorkspaceProvisioner;
  constructor(@Inject(WorkService) private works: WorkService, @Inject(WorkStore) store: WorkStore, @Inject(WorkspaceSettingsService) settings: WorkspaceSettingsService) { this.provisioner = new WorkspaceProvisioner(store, settings); }
  @Get() status(@Param('id') id: string) { return this.provisioner.status(this.works.get(id)); }
  @Get('preview') preview(@Param('id') id: string, @Query('selectedBranch') selectedBranch?: string) { return this.provisioner.preview(this.works.get(id), selectedBranch); }
  @Post('prepare') @HttpCode(200) prepare(@Param('id') id: string, @Body() body: unknown) {
    const work = this.works.get(id);
    if (!new WorkspaceService(this.works.store).hasSpace(work) && (!work.reviewedVersion || work.reviewedVersion !== this.works.planVersion(work))) throw new ConflictException('최신 문서 검토를 먼저 완료해 주세요.');
    return this.provisioner.prepare(work, body);
  }
  // An explicit retry uses the same durable request and actual ownership checks.
  // It cannot choose a new path or silently rerun failed local commands.
  @Post('recover') @HttpCode(200) recover(@Param('id') id: string, @Body() body: unknown) { return this.prepare(id, body); }
  async onModuleDestroy() { await this.provisioner.close(); }
}
