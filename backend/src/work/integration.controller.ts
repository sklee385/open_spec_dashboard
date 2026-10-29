import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { WorkService } from './work.service';
import { IntegrationService } from './integration.service';
import { WorktreeResultCommit } from './worktree-result-commit';
import { DesktopLifecycle } from '../desktop/lifecycle';
@Controller('work/:id/integration')
export class IntegrationController {
  private results: WorktreeResultCommit;
  constructor(@Inject(WorkService) private works: WorkService, @Inject(IntegrationService) private integration: IntegrationService, @Inject(DesktopLifecycle) lifecycle: DesktopLifecycle) { this.results = new WorktreeResultCommit(works.store, works, lifecycle); }
  @Get('commit-preview') preview(@Param('id') id: string) { return this.results.preview(id); }
  @Post('result-commit') @HttpCode(200) commit(@Param('id') id: string, @Body() body: unknown) { return this.results.commit(id, body); }
  @Get() status(@Param('id') id: string) { this.works.get(id); return this.integration.status(id); }
  @Post() @HttpCode(200) async request(@Param('id') id: string, @Body() body: unknown) {
    const request = this.integration.parse(body);
    // Durable replay precedes mutable project/plan/settings/Git checks.
    const replay = this.integration.replay(id, request); if (replay) return replay;
    const readiness = await this.works.integrationReadiness(id, request.reviewedVersion);
    return this.integration.reserve(request, readiness);
  }
}
