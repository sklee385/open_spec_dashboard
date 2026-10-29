import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { WorkService } from './work.service';
import { IntegrationService } from './integration.service';
@Controller('work/:id/integration')
export class IntegrationController {
  constructor(@Inject(WorkService) private works: WorkService, @Inject(IntegrationService) private integration: IntegrationService) {}
  @Get() status(@Param('id') id: string) { this.works.get(id); return this.integration.status(id); }
  @Post() @HttpCode(200) async request(@Param('id') id: string, @Body() body: unknown) {
    const request = this.integration.parse(body);
    // Durable replay precedes mutable project/plan/settings/Git checks.
    const replay = this.integration.replay(id, request); if (replay) return replay;
    const readiness = await this.works.integrationReadiness(id, request.reviewedVersion);
    return this.integration.reserve(request, readiness);
  }
}
