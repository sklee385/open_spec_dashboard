import { ConflictException, Controller, Get, Inject, Injectable, NotFoundException, Post } from '@nestjs/common';
import { WorkStore } from '../work/store';
import { unresolvedQuestion } from '../codex/questions';

@Injectable()
export class DesktopLifecycle {
  locked = false;
  requests = 0;
  constructor(@Inject(WorkStore) private readonly store: WorkStore) {}
  status() {
    const blockers = this.store.list().flatMap(work => {
      const reasons: string[] = [];
      if (!['idle', 'failed', 'interrupted'].includes(work.state)) reasons.push(work.state);
      // Expired input is recoverable history, not a live request awaiting a response.
      if (this.store.records(work.id, 'question').some(q => q.status !== 'expired' && unresolvedQuestion(q))) reasons.push('미처리 질문·승인');
      // Uncertain messages are retained for review and never automatically drained.
      // Active work and requests are checked separately; this history cannot run on its own.
      if (this.store.records(work.id, 'queued-message').some(q => ['pending','queued','dispatching'].includes(q.status))) reasons.push('대기 메시지');
      if (this.store.records(work.id, 'verification').some(q => q.status === 'running')) reasons.push('검증 실행');
      if (this.store.records(work.id, 'browser-verification').some(q => q.status === 'running')) reasons.push('브라우저 검증 실행');
      return reasons.length ? [{ workId: work.id, reasons }] : [];
    });
    return { idle: !blockers.length && this.requests === 0, locked: this.locked, requests: this.requests, blockers };
  }
  prepare() {
    const status = this.status();
    if (!status.idle) throw new ConflictException({ message: '실행·연결·질문·승인 또는 처리 중 요청이 있어 종료를 보류합니다.', ...status });
    // No await between reading all work and blocking new mutating requests.
    this.locked = true;
    return this.status();
  }
}

@Controller('desktop')
export class DesktopController {
  constructor(@Inject(DesktopLifecycle) private readonly lifecycle: DesktopLifecycle) {}
  private enabled() { if (!process.env.DESKTOP_TOKEN) throw new NotFoundException(); }
  @Get('status') status() { this.enabled(); return this.lifecycle.status(); }
  @Post('prepare') prepare() { this.enabled(); return this.lifecycle.prepare(); }
  @Post('cancel') cancel() { this.enabled(); this.lifecycle.locked = false; return this.lifecycle.status(); }
}
