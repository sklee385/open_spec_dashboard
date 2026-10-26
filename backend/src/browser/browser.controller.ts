import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { BrowserService } from './browser.service';

@Controller('work/:id/browser')
export class BrowserController {
  constructor(@Inject(BrowserService) private readonly browser: BrowserService) {}
  @Get() status(@Param('id') id: string) { return this.browser.status(id); }
  @Put('scenario') save(@Param('id') id: string, @Body() body: unknown) { return this.browser.save(id, body); }
  @Post('run') @HttpCode(200) run(@Param('id') id: string) { return this.browser.run(id); }
  @Post('cancel') @HttpCode(200) cancel(@Param('id') id: string) { return this.browser.cancel(id); }
}
