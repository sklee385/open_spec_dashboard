import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { WorkspaceSettingsService } from './workspace-settings.service';

@Controller('workspace-settings')
export class WorkspaceSettingsController {
  constructor(@Inject(WorkspaceSettingsService) private settings: WorkspaceSettingsService) {}
  @Get() read() { return this.settings.view(); }
  @Post('check') check(@Body() body: unknown) { return this.settings.check(body); }
  @Put() save(@Body() body: unknown) { return this.settings.save(body); }
  @Put('policy') policy(@Body() body: unknown) { return this.settings.savePolicy(body); }
  @Get('maintenance') maintenance(@Query() query:Record<string,unknown>={}) { return this.settings.maintenance(query); }
  @Get('roots') roots() { return this.settings.history(); }
  @Delete('roots/:rootId') unregister(@Param('rootId') rootId: string, @Body() body: unknown) { return this.settings.unregister(rootId, body); }
}
