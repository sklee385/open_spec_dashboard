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
import { IntegrationVerification } from './integration-verification';
import { IntegrationApplyPreflight } from './integration-apply-preflight';
import { IntegrationApply } from './integration-apply';
import { IntegrationApplyRecovery } from './integration-apply-recovery';
@Controller('work/:id/integration')
export class IntegrationController {
  private results: WorktreeResultCommit;
  private candidates: IntegrationPreparation;
  constructor(@Inject(WorkService) private works: WorkService, @Inject(IntegrationService) private integration: IntegrationService, @Inject(DesktopLifecycle) lifecycle: DesktopLifecycle, @Inject(WorkspaceSettingsService) settings: WorkspaceSettingsService, @Inject(IntegrationEditing) private editing: IntegrationEditing, @Inject(IntegrationVerification) private verification: IntegrationVerification, @Inject(IntegrationApplyPreflight) private preflight: IntegrationApplyPreflight, @Inject(IntegrationApply) private applying: IntegrationApply, @Inject(IntegrationApplyRecovery) private recovery: IntegrationApplyRecovery) { this.results = new WorktreeResultCommit(works.store, works, lifecycle); this.candidates = new IntegrationPreparation(works.store, works, settings, lifecycle); }
  @Get(':candidateId/apply/status') applyStatus(@Param('id') id: string, @Param('candidateId') candidateId: string, @Query() query: Record<string, unknown>) { return this.recovery.status(id, candidateId, query); }
  @Post(':candidateId/apply/reconcile') @HttpCode(200) applyReconcile(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return this.recovery.reconcile(id, candidateId, body); }
  @Post(':candidateId/cancel') @HttpCode(200) candidateCancel(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return this.recovery.cancel(id, candidateId, body); }
  @Post(':candidateId/apply') @HttpCode(200) apply(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return this.applying.apply(id, candidateId, body); }
  @Get(':candidateId/apply/preview') applyPreview(@Param('id') id: string, @Param('candidateId') candidateId: string, @Query() query: Record<string, unknown>) { if (Object.keys(query).length) throw new BadRequestException('사전검사는 경로·명령 인자를 받지 않습니다'); return this.preflight.preview(id, candidateId); }
  @Post(':candidateId/apply/preflight') @HttpCode(200) applyPreflight(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return this.preflight.confirm(id, candidateId, body); }
  @Post(':candidateId/verification/plan') @HttpCode(200) verificationPlan(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return this.verification.selectPlan(id, candidateId, body); }
  @Get(':candidateId/verification/preview') verificationPreview(@Param('id') id: string, @Param('candidateId') candidateId: string) { return this.verification.preview(id, candidateId); }
  @Get(':candidateId/verification/results') verificationResults(@Param('id') id: string, @Param('candidateId') candidateId: string) { return this.verification.results(id, candidateId); }
  @Get(':candidateId/verification/status') verificationStatus(@Param('id') id: string, @Param('candidateId') candidateId: string) { return this.verification.results(id, candidateId); }
  @Post(':candidateId/verification/run') @HttpCode(200) verificationRun(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return this.verification.run(id, candidateId, body); }
  @Post(':candidateId/verification/cancel') @HttpCode(200) verificationCancel(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return this.verification.cancel(id, candidateId, body); }
  @Post(':candidateId/verification/reconcile') @HttpCode(200) verificationReconcile(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return this.verification.reconcile(id, candidateId, body); }
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
