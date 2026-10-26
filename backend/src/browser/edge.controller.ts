import { Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { EdgeService } from './edge.service';

@Controller()
export class EdgeController {
  constructor(@Inject(EdgeService) private readonly edge: EdgeService) {}
  @Get('browser/edge/status') settings() { return this.edge.settings(); }
  @Get('work/:id/browser/edge') status(@Param('id') id: string) { return this.edge.status(id); }
  @Post('work/:id/browser/edge/pair') @HttpCode(200) pair(@Param('id') id: string) { return this.edge.pair(id); }
  @Delete('work/:id/browser/edge') disconnect(@Param('id') id: string) { return this.edge.disconnect(id); }
}
