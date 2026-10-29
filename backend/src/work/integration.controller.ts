import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { WorkService } from './work.service';
import { IntegrationService } from './integration.service';
import { WorktreeResultCommit } from './worktree-result-commit';
import { DesktopLifecycle } from '../desktop/lifecycle';
import { WorkspaceSettingsService } from './workspace-settings.service';
import { IntegrationPreparation } from './integration-preparation';
import { IntegrationEditing } from './integration-editing';
import { MutationAdmission } from './mutation-admission';
import { createHash } from 'node:crypto';
@Controller('work/:id/integration')
export class IntegrationController {
  private results: WorktreeResultCommit;
  private candidates: IntegrationPreparation;
  constructor(@Inject(WorkService) private works: WorkService, @Inject(IntegrationService) private integration: IntegrationService, @Inject(DesktopLifecycle) lifecycle: DesktopLifecycle, @Inject(WorkspaceSettingsService) settings: WorkspaceSettingsService, @Inject(IntegrationEditing) private editing: IntegrationEditing) { this.results = new WorktreeResultCommit(works.store, works, lifecycle); this.candidates = new IntegrationPreparation(works.store, works, settings, lifecycle); }
  @Get(':candidateId/edit/preview') editPreview(@Param('id') id: string, @Param('candidateId') candidateId: string) { return this.editing.preview(id, candidateId); }
  @Post(':candidateId/edit/stage') @HttpCode(200) editStage(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return this.editing.stage(id, candidateId, body); }
  @Post(':candidateId/edit/commit') @HttpCode(200) editCommit(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return this.editing.commit(id, candidateId, body); }
  @Post(':candidateId/edit/reconcile') @HttpCode(200) editReconcile(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return this.editing.reconcile(id, candidateId, body); }
  @Get(':candidateId/preview') candidatePreview(@Param('id') id: string, @Param('candidateId') candidateId: string) { return this.candidates.preview(id, candidateId); }
  @Post(':candidateId/prepare') @HttpCode(200) candidatePrepare(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return this.candidates.prepare(id, candidateId, body); }
  @Get('commit-preview') preview(@Param('id') id: string) { return this.results.preview(id); }
  @Get('reservation-preview') reservationPreview(@Param('id') id: string, @Query() query: Record<string, unknown>) { if (Object.keys(query).length) throw new BadRequestException('예약 미리보기는 경로·명령 인자를 받지 않습니다.'); return this.integration.reservationPreview(this.works, id); }
  @Post('result-commit') @HttpCode(200) commit(@Param('id') id: string, @Body() body: unknown) { return this.results.commit(id, body); }
  @Get() status(@Param('id') id: string) { this.works.get(id); return this.integration.status(id); }
  @Post() @HttpCode(200) async request(@Param('id') id: string, @Body() body: unknown) {
    const request = this.integration.parse(body);
    // Durable replay precedes mutable project/plan/settings/Git checks.
    const replay = this.integration.replay(id, request); if (replay) return replay;
    const fingerprint = createHash('sha256').update(JSON.stringify([id, request])).digest('hex');
    return new MutationAdmission(this.works.store, id, 'integration-reserve', request.requestKey, fingerprint, () => this.works.store.integrationRequests().some(row => row.workId === id && row.requestKey === request.requestKey)).run(async admission => {
      const readiness = await this.works.integrationReadiness(id, request.reviewedVersion);
      return this.integration.reserve(request, readiness, admission);
    });
  }
}
