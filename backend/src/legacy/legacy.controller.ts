import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Sse } from '@nestjs/common';
import { LegacyService } from './legacy.service';
import { ReviewService } from '../review/review.service';
@Controller()
export class LegacyController {
  constructor(@Inject(LegacyService) private readonly service: LegacyService, @Inject(ReviewService) private readonly review: ReviewService) {}
  @Get('changes/:id/review-items') reviewItems(@Param('id') id: string) { return this.review.change(id); }
  @Get('sources') sources() { return { sources: this.service.sources() }; }
  @Get('config') config() { return this.service.config(); }
  @Put('config/sources') updateSources(@Body() body: unknown) { return this.service.updateSources(body); }
  @Get('ideas') ideas() { return { ideas: this.service.ideas() }; }
  @Post('ideas') @HttpCode(200) create(@Body() body: unknown) { return this.service.saveIdea(body); }
  @Put('ideas/:id') update(@Param('id') id: string, @Body() body: unknown) { return this.service.saveIdea(body, id); }
  @Delete('ideas/:id') remove(@Param('id') id: string) { this.service.deleteIdea(id); return undefined; }
  @Get('changes') changes() { return { changes: this.service.changes() }; }
  @Get('changes/:id') change(@Param('id') id: string) { return this.service.detail(id); }
  @Get('specs') specs() { return { specs: this.service.specs() }; }
  @Get('specs/:id') spec(@Param('id') id: string) { return this.service.spec(id); }
  @Sse('events') events() { return this.service.events(); }
}
