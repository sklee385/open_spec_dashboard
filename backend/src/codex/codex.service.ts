import { BadRequestException, ConflictException, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Work, WorkStore } from '../work/store';
import { LegacyService } from '../legacy/legacy.service';
import { CodexClient } from './client';
import { randomUUID } from 'node:crypto';
import { Subscription } from 'rxjs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { markdownFiles } from '../legacy/parser';
import { textFile, within } from '../files';
import { askUserTool, unresolvedQuestion } from './questions';

@Injectable()
export class CodexService implements OnModuleDestroy {
  readonly client = new CodexClient();
  private loaded = new Set<string>();
  private locks = new Set<string>();
  private draining = new Set<string>();
  private queueSubscription: Subscription;
  private closing = false;
  constructor(@Inject(WorkStore) readonly store: WorkStore, @Inject(LegacyService) readonly legacy: LegacyService) {
    this.queueSubscription = store.updates.subscribe(event => setImmediate(() => { void this.drain(event.workId); }));
    for (const work of this.store.list().filter(work => !work.toolId || work.toolId === 'codex')) {
      if (['running', 'connecting', 'creating-thread', 'waiting-input', 'waiting-approval'].includes(work.state)) {
        work.state = 'recovery-required'; work.error = '서버가 재시작되었습니다. 같은 대화로 복구할 수 있습니다.'; this.store.save(work);
      }
      for (const q of this.store.records(work.id, 'question').filter(x => ['pending', 'sending', 'recovering', 'uncertain'].includes(x.status))) this.store.record(q.id, work.id, 'question', { ...q, status: 'expired' });
      for (const queued of this.store.records(work.id, 'queued-message').filter(x => x.status === 'dispatching')) this.store.record(queued.id, work.id, 'queued-message', { ...queued, status: 'uncertain' });
    }
    this.client.on('notification', message => this.notification(message));
    this.client.on('disconnected', message => {
      this.loaded.clear();
      for (const work of this.store.list().filter(w => w.threadId || w.state === 'creating-thread')) {
        work.state = 'recovery-required'; work.error = message; this.store.save(work);
        for (const q of this.store.records(work.id, 'question').filter(x => x.status === 'pending')) this.store.record(q.id, work.id, 'question', { ...q, status: 'expired' });
      }
      this.legacy.updates.next();
    });
  }
  async status() {
    await this.client.ready(); const result = await this.client.rpc('account/read', { refreshToken: false });
    return { connected: true, authenticated: !!result.account, accountType: result.account?.type ?? null };
  }
  async send(id: string, text: string, phase?: string) {
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new BadRequestException('메시지를 입력해 주세요');
    const work = this.store.get(id);
    if (!work) throw new BadRequestException('업무가 없습니다');
    if (['implementation', 'verification'].includes(phase || work.phase)) this.requireReviewedPlan(work);
    if (['archived', 'completed'].includes(work.phase)) throw new ConflictException('완료된 업무는 수정 단계로 다시 열어 주세요');
    if (this.locks.has(id) || ['running', 'waiting-input', 'waiting-approval', 'connecting', 'creating-thread'].includes(work.state)) {
      const queuedId = randomUUID(); this.store.record(queuedId, id, 'queued-message', { text, phase, status: 'queued' });
      this.store.event(id, 'message-queued', { id: queuedId, text }); return { ...work, queued: true };
    }
    if (work.state === 'recovery-required' && !work.threadId) throw new ConflictException('대화 생성 결과가 불명확합니다. 새 대화를 자동 생성하지 않습니다');
    this.locks.add(id); work.state = 'connecting'; this.store.save(work);
    try {
      await this.client.ready();
      if (!work.threadId) {
        work.state = 'creating-thread'; this.store.save(work);
        const result = await this.client.rpc('thread/start', { cwd: work.projectPath, ephemeral: false, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', dynamicTools: [askUserTool],
          developerInstructions: '사용자와 한국어로 문답하며 같은 업무를 계속 진행한다. 불명확한 요구사항은 ask_user 도구로 질문하고 답변을 관련 문서에 반영한다. 계획 단계에서는 지정된 OpenSpec 변경 문서만 작성·수정하고 제품 코드를 구현하지 않는다. 구현은 사용자의 구현 시작 지시 후에 진행한다. 문서 작성·구현·검증 결과 생성만으로 사용자 검토나 완료를 대체하지 않는다.' });
        work.threadId = result.thread.id; work.providerSessionId = work.threadId; this.store.save(work); this.loaded.add(work.threadId!);
      } else if (!this.loaded.has(work.threadId)) {
        await this.client.rpc('thread/resume', { threadId: work.threadId, cwd: work.projectPath, excludeTurns: true, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
        this.loaded.add(work.threadId);
      }
      if (phase) work.phase = phase;
      if (['implementation', 'verification'].includes(work.phase)) this.requireReviewedPlan(this.store.get(id)!);
      work.documentVersions = this.documentVersions(work);
      work.state = 'running'; delete work.error; delete work.errorCode; this.store.save(work);
      this.store.event(id, 'user-message', { text });
      const result = await this.client.rpc('turn/start', { threadId: work.threadId, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', input: [{ type: 'text', text: `현재 업무: ${work.changeName}\n현재 단계: ${work.phase}\nOpenSpec 변경: openspec/changes/${work.changeName}\n\n${text}`, text_elements: [] }] });
      const latest = this.store.get(id)!; latest.turnId = result.turn.id; this.store.save(latest); this.legacy.updates.next(); return latest;
    } catch (error: any) {
      throw this.connectionFailure(id, error);
    } finally { this.locks.delete(id); }
  }
  private connectionFailure(id: string, error: Error) {
    const latest = this.store.get(id)!;
    const conflict = /already has an active writer/.test(error.message);
    latest.state = 'recovery-required';
    latest.error = conflict ? '다른 Codex 앱에서 이 업무 대화를 사용 중입니다. 해당 앱에서 이 대화를 닫은 뒤 ‘같은 대화 다시 연결’을 눌러 주세요. 문서와 대화 기록은 유지됩니다.' : error.message;
    if (conflict) { latest.errorCode = 'thread-in-use'; if (latest.threadId) this.loaded.delete(latest.threadId); }
    else delete latest.errorCode;
    this.store.save(latest); this.legacy.updates.next();
    return new ConflictException({ message: latest.error, errorCode: latest.errorCode });
  }
  async reconnect(id: string) {
    const work = this.store.get(id);
    if (!work?.threadId) throw new ConflictException('복구할 기존 대화가 없습니다. 새 대화를 자동 생성하지 않습니다.');
    if (this.locks.has(id) || !['recovery-required', 'idle', 'interrupted', 'failed'].includes(work.state)) throw new ConflictException('실행을 마친 뒤 다시 연결해 주세요.');
    this.locks.add(id); work.state = 'connecting'; this.store.save(work);
    try {
      await this.client.ready();
      await this.client.rpc('thread/resume', { threadId: work.threadId, cwd: work.projectPath, excludeTurns: true, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
      this.loaded.add(work.threadId);
      const latest = this.store.get(id)!; latest.state = 'idle'; delete latest.error; delete latest.errorCode; this.store.save(latest);
      this.store.event(id, 'thread-reconnected', { threadId: work.threadId }); this.legacy.updates.next(); return latest;
    } catch (error: any) { throw this.connectionFailure(id, error); }
    finally { this.locks.delete(id); }
  }
  private notification(message: any) {
    if (message.generation && message.generation !== this.client.generation) return;
    const params = message.params || {}, work = this.store.list().find(w => w.threadId === params.threadId);
    if (!work) return;
    if (message.id !== undefined) {
      const dynamic = message.method === 'item/tool/call';
      if (dynamic) {
        const questions = params.arguments?.questions;
        if (params.tool !== 'ask_user' || !Array.isArray(questions) || !questions.length || questions.some((q: any) => typeof q.id !== 'string' || typeof q.question !== 'string')) {
          this.client.respond(message.id, { success: false, contentItems: [{ type: 'inputText', text: '지원하지 않는 도구 또는 잘못된 질문입니다. ask_user 질문 형식으로 다시 요청해 주세요.' }] }); return;
        }
        params.questions = questions;
      }
      const kind = message.method === 'item/tool/requestUserInput' || dynamic ? 'input' : 'approval';
      this.store.record(`${this.client.generation}:${message.id}`, work.id, 'question', { requestId: message.id, generation: this.client.generation, kind, method: message.method, params, status: 'pending', createdAt: new Date().toISOString() });
      work.state = kind === 'input' ? 'waiting-input' : 'waiting-approval'; this.store.save(work);
    } else if (message.method === 'turn/completed') {
      for (const q of this.store.records(work.id, 'question').filter(q => q.status === 'pending' && q.params.turnId === params.turn?.id && q.generation === this.client.generation)) {
        this.store.record(q.id, work.id, 'question', { ...q, status: 'expired' }); this.client.requests.delete(q.requestId);
      }
      work.state = params.turn?.status === 'completed' ? 'idle' : params.turn?.status === 'interrupted' ? 'interrupted' : 'failed';
      if (params.turn?.error) work.error = params.turn.error.message;
      const before = work.documentVersions as Record<string, string> || {}, after = this.documentVersions(work);
      const changed = Object.keys(after).filter(path => before[path] !== after[path]);
      for (const q of this.store.records(work.id, 'question').filter(x => x.status === 'answered' && x.params.turnId === params.turn?.id && x.reflection === 'pending')) {
        this.store.record(q.id, work.id, 'question', { ...q, reflection: changed.length ? 'applied' : 'needs-review', documents: changed.map(path => ({ path, version: after[path] })) });
      }
      this.store.save(work);
    } else if (message.method === 'item/completed' && params.item?.type === 'dynamicToolCall' && params.item.success === false) {
      const q = this.store.records(work.id, 'question').find(q => q.status === 'pending' && q.params.callId === params.item.id && q.generation === this.client.generation);
      if (q) { this.store.record(q.id, work.id, 'question', { ...q, status: 'expired' }); this.client.requests.delete(q.requestId); }
    } else if (message.method === 'serverRequest/resolved') {
      const q = this.store.records(work.id, 'question').find(x => x.requestId === params.requestId && x.generation === this.client.generation && x.status === 'pending');
      if (q) this.store.record(q.id, work.id, 'question', { ...q, status: 'expired' });
    }
    this.store.event(work.id, message.method, params); this.legacy.updates.next();
  }
  async answer(id: string, body: any) {
    const q = this.store.records(id, 'question').find(x => x.id === body?.questionId);
    const recovery = q?.status === 'expired' && body?.recover === true;
    if (!q || (!recovery && (q.status !== 'pending' || q.generation !== this.client.generation))) throw new ConflictException('이미 답변했거나 만료된 질문입니다');
    if (q.kind !== 'input') throw new BadRequestException('실행 승인은 별도 동작으로 처리해야 합니다');
    if (!body.answers || typeof body.answers !== 'object') throw new BadRequestException('답변이 필요합니다');
    for (const question of q.params.questions) {
      const answer = body.answers[question.id];
      if (!answer || !Array.isArray(answer.answers) || !answer.answers.length || answer.answers.some((x: unknown) => typeof x !== 'string' || !x.trim())) throw new BadRequestException('모든 질문에 답변해 주세요');
    }
    if (recovery) {
      const work = this.store.get(id)!;
      if (!['idle', 'interrupted', 'failed', 'recovery-required'].includes(work.state)) throw new ConflictException('현재 실행을 마친 뒤 답변을 복구해 주세요');
      this.store.record(q.id, id, 'question', { ...q, status: 'recovering', answer: body.answers });
      try {
        const result = await this.send(id, `연결 종료로 만료된 확인 질문의 사용자 답변을 같은 대화에 복구한다. 질문: ${JSON.stringify(q.params.questions)}\n답변: ${JSON.stringify(body.answers)}\n결정을 관련 문서에 반영하고, 구현 전에 사용자 문서 검토를 다시 받는다. 제품 코드는 구현하지 않는다.`, 'planning');
        this.store.record(q.id, id, 'question', { ...q, params: { ...q.params, turnId: result.turnId }, status: 'answered', answer: body.answers, recovered: true, reflection: 'pending' });
        this.store.event(id, 'answer-recovered', { questionId: q.id, answers: body.answers }); return { ok: true, recovered: true };
      } catch (error) { this.store.record(q.id, id, 'question', { ...q, status: 'expired', answerDraft: body.answers }); throw error; }
    }
    this.store.record(q.id, id, 'question', { ...q, status: 'sending', answer: body.answers, reflection: 'pending' });
    try { this.client.respond(q.requestId, q.method === 'item/tool/call' ? { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ answers: body.answers }) }] } : { answers: body.answers }); }
    catch (error: any) { this.store.record(q.id, id, 'question', { ...q, status: 'uncertain', answer: body.answers }); throw new ConflictException(error.message); }
    this.store.record(q.id, id, 'question', { ...q, status: 'answered', answer: body.answers, reflection: 'pending' });
    const work = this.store.get(id)!; work.state = 'running'; this.store.save(work); this.store.event(id, 'answer', { questionId: q.id, answers: body.answers }); this.legacy.updates.next(); return { ok: true };
  }
  approval(id: string, body: any) {
    const q = this.store.records(id, 'question').find(x => x.id === body?.questionId);
    if (!q || q.status !== 'pending' || q.generation !== this.client.generation) throw new ConflictException('만료되거나 처리된 승인 요청입니다');
    if (q.kind !== 'approval' || !['accept', 'decline'].includes(body.decision)) throw new BadRequestException('올바른 승인 응답이 아닙니다');
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'];
    if (!supported.includes(q.method)) throw new BadRequestException('지원하지 않는 승인 유형입니다');
    const response = q.method === 'item/permissions/requestApproval' ? { permissions: body.decision === 'accept' ? q.params.permissions : {}, scope: 'turn' } : { decision: body.decision };
    this.store.record(q.id, id, 'question', { ...q, status: 'sending', decision: body.decision });
    try { this.client.respond(q.requestId, response); }
    catch (error: any) { this.store.record(q.id, id, 'question', { ...q, status: 'uncertain', decision: body.decision }); throw new ConflictException(error.message); }
    this.store.record(q.id, id, 'question', { ...q, status: 'answered', decision: body.decision });
    const work = this.store.get(id)!; work.state = 'running'; this.store.save(work); this.store.event(id, 'approval', { questionId: q.id, decision: body.decision }); return { ok: true };
  }
  private documentVersions(work: Work) {
    const root = within(this.legacy.source(work.sourceId).path, `changes/${work.changeName}`);
    const paths = ['proposal.md', 'design.md', 'tasks.md', ...markdownFiles(join(root, 'specs')).map(x => `specs/${x}`)];
    return Object.fromEntries(paths.map(path => { const content = textFile(within(root, path)); return [path, content === null ? '' : createHash('sha256').update(content).digest('hex')]; }));
  }
  requireReviewedPlan(work: Work) {
    const root = within(this.legacy.source(work.sourceId).path, `changes/${work.changeName}`);
    const paths = ['proposal.md', 'design.md', 'tasks.md', ...markdownFiles(join(root, 'specs')).map(path => `specs/${path}`)].filter(path => textFile(within(root, path)) !== null);
    const version = createHash('sha256').update(paths.map(path => `${path}\n${textFile(within(root, path))!.replace(/- \[[xX ]\]/g, '- [ ]')}`).join('\n')).digest('hex');
    if (!work.reviewedVersion || work.reviewedVersion !== version || this.store.records(work.id, 'question').some(unresolvedQuestion)) throw new ConflictException('구현 전 최신 문서 검토와 질문 해결이 필요합니다. 문서 수정은 계획 작성·수정에서 진행해 주세요.');
  }
  private async drain(id: string) {
    if (this.closing || this.draining.has(id) || this.locks.has(id)) return;
    const work = this.store.get(id); if (!work || (work.toolId && work.toolId !== 'codex') || work.state !== 'idle' || ['completed', 'archived'].includes(work.phase)) return;
    const queued = this.store.records(id, 'queued-message').find(x => x.status === 'queued'); if (!queued) return;
    this.draining.add(id); this.store.record(queued.id, id, 'queued-message', { ...queued, status: 'dispatching' });
    try { await this.send(id, queued.text, queued.phase); this.store.record(queued.id, id, 'queued-message', { ...queued, status: 'sent' }); }
    catch (error: any) { const status = error instanceof ConflictException && this.store.get(id)?.state === 'idle' ? 'blocked' : 'uncertain'; this.store.record(queued.id, id, 'queued-message', { ...queued, status, error: error.message }); this.store.event(id, 'queue-stopped', { id: queued.id, status, error: error.message }); }
    finally { this.draining.delete(id); }
  }
  async interrupt(id: string) {
    const work = this.store.get(id)!; if (!work?.threadId || !work.turnId) throw new ConflictException('실행 중인 턴이 없습니다');
    await this.client.rpc('turn/interrupt', { threadId: work.threadId, turnId: work.turnId }); return { requested: true };
  }
  async onModuleDestroy() { this.closing = true; this.queueSubscription.unsubscribe(); this.client.removeAllListeners(); await this.client.close(); }
}
