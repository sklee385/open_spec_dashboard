import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Sse } from '@nestjs/common';
import { WorkService } from './work.service';
import { AiToolService } from '../ai-tools/ai-tool.service';
import { OpenSpecService } from '../openspec/openspec.service';
import { ReviewService } from '../review/review.service';
import { workTool, capabilities, readiness } from '../ai-tools/config.service';
@Controller('work')
export class WorkController {
  constructor(@Inject(WorkService) readonly service: WorkService, @Inject(AiToolService) readonly codex: AiToolService, @Inject(OpenSpecService) readonly openspec: OpenSpecService, @Inject(ReviewService) readonly review: ReviewService) {}
  @Get(':id/review-items') reviewItems(@Param('id') id: string) { return this.review.read(this.service.root(this.service.get(id))); }
  @Get() list() { return { work: this.service.list().map(work => this.toolInfo(work)) }; }
  @Get('attention') attention() { return { items: this.service.store.attention() }; }
  private toolInfo(work: any) { const tool = workTool(work); return { ...work, toolId: tool.id, toolConfigSnapshot: tool, toolCapabilities: capabilities(tool), toolReadiness: readiness(tool), providerSessionId: tool.kind === 'codex' ? work.threadId : null }; }
  @Post() @HttpCode(200) create(@Body() body: unknown) { return this.service.create(body); }
  @Get(':id') get(@Param('id') id: string) { const work = this.service.get(id); const reviewRequired = !!work.reviewedVersion && work.reviewedVersion !== this.service.planVersion(work); return { ...this.toolInfo(work), reviewRequired, reviewedVersion: reviewRequired ? null : work.reviewedVersion, documents: this.service.documents(work), events: this.service.store.events(id), questions: this.service.store.records(id, 'question'), queuedMessages: this.service.store.records(id, 'queued-message'), verifications: this.service.execution.results(work), verificationCommands: this.service.execution.commands(work), workVerificationCommands: this.service.execution.commands(work, 'work'), changes: this.service.execution.changes(work) }; }
  @Get(':id/document') document(@Param('id') id: string, @Query('path') path: string) { return this.service.document(id, path); }
  @Put(':id/document') save(@Param('id') id: string, @Body() body: unknown) { return this.service.saveDocument(id, body); }
  @Post(':id/action') @HttpCode(200) action(@Param('id') id: string, @Body() body: unknown) { return this.service.action(id, body); }
  @Post(':id/message') @HttpCode(200) message(@Param('id') id: string, @Body() body: any) { this.service.get(id); return this.codex.send(id, body?.text); }
  @Post(':id/reconnect') @HttpCode(200) reconnect(@Param('id') id: string) { this.service.get(id); return this.codex.reconnect(id); }
  @Post(':id/answer') @HttpCode(200) answer(@Param('id') id: string, @Body() body: unknown) { this.service.get(id); return this.codex.answer(id, body); }
  @Post(':id/approval') @HttpCode(200) approval(@Param('id') id: string, @Body() body: unknown) { this.service.get(id); return this.codex.approval(id, body); }
  @Post(':id/interrupt') @HttpCode(200) interrupt(@Param('id') id: string) { this.service.get(id); if (this.service.execution.interrupt(id)) return { requested: true }; return this.codex.interrupt(id); }
  @Get(':id/openspec') inspect(@Param('id') id: string, @Query('operation') operation: string, @Query('artifact') artifact?: string) { const work = this.service.get(id); return this.openspec.inspect(work.projectPath, work.changeName, operation, artifact); }
  @Sse(':id/events') events(@Param('id') id: string, @Query('after') after?: string, @Headers('last-event-id') lastId?: string) { return this.service.events(id, Number(lastId || after || 0)); }
  @Put(':id/verification-plan') plan(@Param('id') id: string, @Body() body: unknown) { return this.service.execution.setCommands(this.service.get(id), body); }
  @Post(':id/verify') @HttpCode(200) verify(@Param('id') id: string, @Body() body: any) { return this.service.execution.run(this.service.get(id), body?.commandId, body?.scope); }
  @Post(':id/verify-all') @HttpCode(200) verifyAll(@Param('id') id: string, @Body() body: any) { return this.service.execution.runAll(this.service.get(id), body?.scope); }
}
