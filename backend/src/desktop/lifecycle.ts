import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Injectable, NotFoundException, Param, Post } from '@nestjs/common';
import { WorkStore } from '../work/store';
import { unresolvedQuestion } from '../codex/questions';
import { desktopHealth } from './health';
import { AiToolService } from '../ai-tools/ai-tool.service';
import { ExecutionService } from '../work/execution.service';
import { BrowserService } from '../browser/browser.service';
import { projectCoordinator } from '../projects/coordinator';

@Injectable()
export class DesktopLifecycle {
  locked = false;
  requests = 0;
  readonly requestDetails = new Map<symbol, { kind: string; workId?: string; startedAt: string }>();
  constructor(@Inject(WorkStore) private readonly store: WorkStore) {}
  beginRequest(kind: string, workId?: string) {
    const key = Symbol(); this.requests++;
    this.requestDetails.set(key, { kind, ...(workId ? { workId } : {}), startedAt: new Date().toISOString() });
    return () => { if (this.requestDetails.delete(key)) this.requests--; };
  }
  diagnostics() {
    const health = desktopHealth(this.store);
    const works = this.store.list().map(work => {
      const runtime = health.runtime(work), reasons = this.reasons(work.id);
      const stale = !['completed', 'archived'].includes(work.phase) && ['running', 'connecting', 'creating-thread', 'waiting-input', 'waiting-approval', 'recovery-required'].includes(work.state);
      const canRecover = runtime === 'inactive' && stale && !reasons.length && !['completed', 'archived'].includes(work.phase);
      return { id: work.id, name: work.changeName, state: work.state, phase: work.phase, runtime,
        status: runtime === 'unknown' ? 'unknown' : runtime === 'active' ? 'running' : stale ? 'mismatch' : 'normal',
        reasons: [...(runtime === 'active' ? ['실제 실행이 진행 중입니다'] : runtime === 'unknown' ? ['이전 실행 또는 외부 프로세스의 종료를 확인할 수 없습니다'] : stale ? ['실행은 없으나 저장 상태 확인이 필요합니다'] : []), ...reasons],
        updatedAt: work.updatedAt, canRecover, canInterrupt: runtime === 'active' || health.canInterrupt(work) };
    });
    return { checkedAt: new Date().toISOString(), safeMode: health.safeMode, ...this.status(), works, history: [...health.history], requestDetails: [...this.requestDetails.values()].slice(-100) };
  }
  private reasons(id: string) {
    const reasons: string[] = [];
    const work = this.store.get(id);
    if (work && ['completed', 'archived'].includes(work.phase) && desktopHealth(this.store).runtime(work) === 'inactive') return reasons;
    if (this.store.records(id, 'question').some(q => q.status !== 'expired' && unresolvedQuestion(q))) reasons.push('미처리 질문·승인');
    if (this.store.records(id, 'queued-message').some(q => ['pending', 'queued', 'dispatching'].includes(q.status))) reasons.push('대기 메시지');
    if (this.store.records(id, 'verification').some(q => q.status === 'running')) reasons.push('검증 실행');
    if (this.store.records(id, 'browser-verification').some(q => q.status === 'running')) reasons.push('브라우저 검증 실행');
    return reasons;
  }
  assertUnlocked() { if (this.locked) throw new ConflictException('앱 종료·업데이트 준비 중입니다'); }
  setSafeMode(body: any) {
    this.assertUnlocked(); if (typeof body?.enabled !== 'boolean') throw new BadRequestException('enabled는 boolean이어야 합니다');
    if (!body.enabled && desktopHealth(this.store).safeMode) {
      this.store.transaction(() => {
        for (const work of this.store.list()) for (const queued of this.store.records(work.id, 'queued-message').filter(row => ['pending', 'queued'].includes(row.status))) {
          this.store.record(queued.id, work.id, 'queued-message', { ...queued, status: 'blocked', error: '안전 모드에서 보류한 메시지입니다. 내용을 확인하고 직접 다시 보내 주세요.' });
        }
      });
    }
    desktopHealth(this.store).setSafeMode(body.enabled); return this.diagnostics();
  }
  recover(id: string) {
    this.assertUnlocked();
    const entry = this.diagnostics().works.find(work => work.id === id);
    if (!entry) throw new NotFoundException('업무를 찾을 수 없습니다');
    if (!entry.canRecover || this.requests) throw new ConflictException('실행·요청·질문·승인·대기열 또는 확인 불가 상태에서는 복구할 수 없습니다');
    // Synchronous ownership check and save: no new execution can enter in between.
    const work = this.store.get(id)!; projectCoordinator(this.store).assertWorkCanStart(work);
    work.state = 'interrupted'; delete work.error; delete work.errorCode; this.store.save(work);
    desktopHealth(this.store).event('work-recovered', id, 'interrupted'); return work;
  }
  status() {
    const blockers = this.store.list().flatMap(work => {
      const reasons: string[] = [];
      const runtime = desktopHealth(this.store).runtime(work);
      if (runtime === 'active' || runtime === 'unknown') reasons.push(runtime === 'active' ? '실행 중' : '실행 종료 확인 불가');
      reasons.push(...this.reasons(work.id));
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
  constructor(@Inject(DesktopLifecycle) private readonly lifecycle: DesktopLifecycle,
    @Inject(AiToolService) private readonly tools: AiToolService,
    @Inject(ExecutionService) private readonly execution: ExecutionService,
    @Inject(BrowserService) private readonly browser: BrowserService) {}
  private enabled() { if (!process.env.DESKTOP_TOKEN) throw new NotFoundException(); }
  @Get('status') status() { this.enabled(); return this.lifecycle.status(); }
  @Post('prepare') prepare() { this.enabled(); return this.lifecycle.prepare(); }
  @Post('cancel') cancel() { this.enabled(); this.lifecycle.locked = false; return this.lifecycle.status(); }
  @Get('diagnostics') diagnostics() { this.enabled(); return this.lifecycle.diagnostics(); }
  @Post('recover/:id') recover(@Param('id') id: string) { this.enabled(); return this.lifecycle.recover(id); }
  @Post('safe-mode') safeMode(@Body() body: unknown) { this.enabled(); return this.lifecycle.setSafeMode(body); }
  @Post('interrupt/:id') async interrupt(@Param('id') id: string) {
    this.enabled(); this.lifecycle.assertUnlocked();
    const work = this.lifecycle.diagnostics().works.find(work => work.id === id);
    if (!work?.canInterrupt) throw new ConflictException('소유한 실행을 확인할 수 없습니다');
    if (this.execution.interrupt(id)) return { requested: true };
    if (this.browser.status(id).running) { await this.browser.cancel(id); return { requested: true }; }
    return this.tools.interrupt(id);
  }
}
