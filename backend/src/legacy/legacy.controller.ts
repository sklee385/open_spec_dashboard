import { Body, Controller, Delete, Get, HttpCode, Inject, Optional, Param, Post, Put, Sse } from '@nestjs/common';
import { LegacyService } from './legacy.service';
import { ReviewService } from '../review/review.service';
import { WorkStore } from '../work/store';
import { projectCoordinator } from '../projects/coordinator';
import { dirname, join } from 'node:path';
import { gitCommonDirectory } from '../projects/git-metadata';
import { workManagement } from '../work/management';
@Controller()
export class LegacyController {
  constructor(@Inject(LegacyService) private readonly service: LegacyService, @Inject(ReviewService) private readonly review: ReviewService, @Optional() @Inject(WorkStore) private readonly store?: WorkStore) {}
  private ideaMutation<T>(sourceId: string, run: () => T): T {
    const source = this.service.source(sourceId), root = dirname(source.path);
    const release = this.store ? projectCoordinator(this.store).acquireOperation({ kind: 'workspace', root: join(source.path, 'ideas'), commonDir: gitCommonDirectory(root) ?? undefined }) : () => {};
    try { return run(); } finally { release(); }
  }
  @Get('changes/:id/review-items') reviewItems(@Param('id') id: string) { return this.review.change(id); }
  @Get('sources') sources() { return { sources: this.service.sources() }; }
  @Get('config') config() { return this.service.config(); }
  @Put('config/sources') updateSources(@Body() body: unknown) { return this.service.updateSources(body); }
  @Get('ideas') ideas() { return { ideas: this.service.ideas() }; }
  @Post('ideas') @HttpCode(200) create(@Body() body: any) { this.service.validateIdea(body); return this.ideaMutation(body.sourceId, () => this.service.saveIdea(body)); }
  @Put('ideas/:id') update(@Param('id') id: string, @Body() body: unknown) { return this.ideaMutation(this.service.splitId(id)[0], () => this.service.saveIdea(body, id)); }
  @Delete('ideas/:id') remove(@Param('id') id: string) { return this.ideaMutation(this.service.splitId(id)[0], () => this.service.deleteIdea(id)); }
  @Get('changes') changes() {
    const work = this.store?.list() ?? [];
    return { changes: this.service.changes().map(change => {
      const linked = work.find(item => item.sourceId === change.sourceId && item.changeName === change.name && item.projectPath === dirname(this.service.source(change.sourceId).path));
      if (!linked || !this.store) return change;
      const management = workManagement(this.store, linked.id), status = { active: 'in_progress', completed: 'done', archived: 'archived' }[management.state as string];
      return { ...change, ...(status ? { status, observedStatus: change.status, managementState: management.state } : {}) };
    }) };
  }
  @Get('changes/:id') change(@Param('id') id: string) { return this.service.detail(id); }
  @Get('specs') specs() { return { specs: this.service.specs() }; }
  @Get('specs/:id') spec(@Param('id') id: string) { return this.service.spec(id); }
  @Sse('events') events() { return this.service.events(); }
}
