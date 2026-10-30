import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { BrowserService } from './browser.service';
import { runBrowserTarget, browserCancelBody, cancelBrowserTarget, reconcileBrowserTarget } from './browser-controls';

@Controller('work/:id')
export class BrowserController {
  constructor(@Inject(BrowserService) private readonly browser: BrowserService) {}
  private inspect(query: Record<string, unknown>) { if (Object.keys(query).some(key => key !== 'inspect') || query.inspect !== undefined && query.inspect !== '1') throw new BadRequestException('실제 브라우저 상태 검사는 inspect=1만 사용할 수 있습니다'); return query.inspect === '1'; }
  @Get('browser') status(@Param('id') id: string, @Query() query: Record<string, unknown> = {}) { return this.browser.status(id, this.inspect(query)); }
  @Get('integration/:candidateId/browser') candidateStatus(@Param('id') id: string, @Param('candidateId') candidateId: string, @Query() query: Record<string, unknown> = {}) { return this.browser.status(id, this.inspect(query), candidateId); }
  @Put('browser/scenario') save(@Param('id') id: string, @Body() body: unknown) { return this.browser.save(id, body); }
  @Post('browser/run') @HttpCode(200) run(@Param('id') id: string, @Body() body?: unknown) { return runBrowserTarget(this.browser, id, null, body); }
  @Post('browser/reconcile') @HttpCode(200) reconcile(@Param('id') id: string, @Body() body: unknown) { return reconcileBrowserTarget(this.browser, id, null, body); }
  @Post('integration/:candidateId/browser/reconcile') @HttpCode(200) reconcileCandidate(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body: unknown) { return reconcileBrowserTarget(this.browser, id, candidateId, body); }
  @Post('browser/cancel') @HttpCode(200) cancel(@Param('id') id: string, @Body() body?: unknown) { return cancelBrowserTarget(this.browser, id, null, browserCancelBody(body, false)); }
  @Post('integration/:candidateId/browser/run') @HttpCode(200) runCandidate(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body?: unknown) { return runBrowserTarget(this.browser, id, candidateId, body); }
  @Post('integration/:candidateId/browser/cancel') @HttpCode(200) cancelCandidate(@Param('id') id: string, @Param('candidateId') candidateId: string, @Body() body?: unknown) { return cancelBrowserTarget(this.browser, id, candidateId, browserCancelBody(body, true)); }
}
