import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { mkdirSync, existsSync, renameSync } from 'node:fs';
import { Observable } from 'rxjs';
import { LegacyService } from '../legacy/legacy.service';
import { Work, WorkStore } from './store';
import { atomicWrite, textFile, within } from '../files';
import { markdownFiles } from '../legacy/parser';
import { AiToolService } from '../ai-tools/ai-tool.service';
import { OpenSpecService } from '../openspec/openspec.service';
import { ExecutionService } from './execution.service';
import { unresolvedQuestion } from '../codex/questions';
import { AiToolConfigService, capabilities, workTool } from '../ai-tools/config.service';
import { ReviewService } from '../review/review.service';
import { guidedReviewInstructions } from '../review/instructions';
import { FileResults, snapshotRevision } from './file-results';
import { projectCoordinator } from '../projects/coordinator';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
@Injectable()
export class WorkService {
  private creating = new Map<string, Promise<Work>>();
  private guidedReviewStarting = new Set<string>();
  constructor(@Inject(WorkStore) readonly store: WorkStore, @Inject(LegacyService) readonly legacy: LegacyService,
    @Inject(AiToolService) readonly codex: AiToolService, @Inject(OpenSpecService) readonly openspec: OpenSpecService,
    @Inject(ExecutionService) readonly execution: ExecutionService, @Inject(AiToolConfigService) readonly tools: AiToolConfigService,
    @Inject(ReviewService) readonly review: ReviewService) {}
  get(id: string): Work { const work = this.store.get(id); if (!work) throw new NotFoundException('업무를 찾을 수 없습니다'); if (['completed', 'archived'].includes(work.phase)) return work; const source = this.legacy.source(work.sourceId); if (dirname(source.path) !== work.projectPath) throw new ConflictException('프로젝트 경로가 변경되었습니다'); return work; }
  create(body: any) {
    const key = `${body?.sourceId}:${body?.changeName}`;
    const pending = this.creating.get(key); if (pending) return pending;
    const promise = this.createWork(body).finally(() => this.creating.delete(key)); this.creating.set(key, promise); return promise;
  }
  private async createWork(body: any): Promise<Work> {
    if (!body || typeof body.sourceId !== 'string' || typeof body.changeName !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.changeName) || typeof body.requestKey !== 'string' || !body.requestKey) throw new BadRequestException('Invalid work request');
    const source = this.legacy.source(body.sourceId);
    const archived = this.store.list().find(w => w.sourceId === source.id && w.phase === 'archived' && w.archiveName === body.changeName);
    if (archived) return archived;
    const existing = this.store.list().find(w => w.requestKey === body.requestKey || (w.sourceId === source.id && w.changeName === body.changeName));
    if (existing) {
      if (existing.sourceId !== source.id || existing.changeName !== body.changeName) throw new ConflictException('요청 키가 다른 업무에 사용되었습니다');
      if (existing.phase !== 'archived') this.preserveIdeas(existing);
      return existing;
    }
    const idea = body.ideaId ? this.legacy.ideas().find(x => x.id === body.ideaId && x.sourceId === source.id) : null;
    if (body.ideaId && !idea) throw new BadRequestException('아이디어를 찾을 수 없습니다');
    if (!existsSync(within(source.path, `changes/${body.changeName}`))) {
      if (!idea) throw new NotFoundException('변경이 없습니다');
      const context = await this.openspec.run(dirname(source.path), ['context', '--json']);
      if (!context.ok || resolve(context.json?.root?.path || '') !== resolve(dirname(source.path))) throw new ConflictException('OpenSpec 루트가 등록 프로젝트와 일치하지 않습니다');
      const result = await this.openspec.run(dirname(source.path), ['new', 'change', body.changeName]);
      if (!result.ok) throw new ConflictException({ error: '변경 생성에 실패했습니다. 아이디어를 보존했습니다.', result });
    }
    this.legacy.detail(`${source.id}/${body.changeName}`);
    const now = new Date().toISOString();
    const work: Work = { id: randomUUID(), sourceId: source.id, projectPath: dirname(source.path), changeName: body.changeName,
      requestKey: body.requestKey, ideaIds: idea ? [idea.id] : [], phase: 'planning', state: 'idle', threadId: null, reviewedVersion: null, createdAt: now, updatedAt: now, ...this.tools.snapshot() };
    this.store.save(work);
    this.preserveIdeas(work);
    this.store.event(work.id, 'created', { changeName: work.changeName }); this.legacy.updates.next(); return work;
  }
  private preserveIdeas(work: Work) {
    const source = this.legacy.source(work.sourceId);
    for (const id of work.ideaIds) {
      const filename = `${this.legacy.splitId(id)[1]}.md`;
      const from = within(source.path, `ideas/${filename}`), destination = within(source.path, `changes/${work.changeName}/source-ideas/${filename}`);
      if (!existsSync(from) && existsSync(destination)) continue;
      if (!existsSync(from) || existsSync(destination)) throw new ConflictException('원본 아이디어와 보존 경로를 확인해 주세요. 기존 업무는 유지됩니다.');
      const idea = this.legacy.ideas().find(idea => idea.id === id)!;
      mkdirSync(dirname(destination), { recursive: true }); renameSync(from, destination);
      this.store.event(work.id, 'source-idea', { title: idea.title, description: idea.description, id }); this.legacy.updates.next();
    }
  }
  events(id: string, after: number) {
    this.get(id);
    if (!Number.isSafeInteger(after) || after < 0) throw new BadRequestException('잘못된 이벤트 커서입니다');
    return new Observable<any>(subscriber => {
      let cursor = after;
      const emit = () => { try { for (const event of this.store.events(id, cursor)) { cursor = event.seq; subscriber.next({ id: String(event.seq), type: 'work-update', data: event }); } } catch (error) { subscriber.error(error); } };
      const subscription = this.store.updates.subscribe(event => { if (event.workId === id) emit(); });
      emit(); const timer = setInterval(() => subscriber.next({ type: 'heartbeat', data: '{}' }), 15000);
      return () => { subscription.unsubscribe(); clearInterval(timer); };
    });
  }
  root(work: Work) {
    if (work.executionPath && !['completed', 'archived'].includes(work.phase)) return within(this.execution.executionPath(work), `openspec/changes/${work.changeName}`);
    const source = this.legacy.source(work.sourceId), active = within(source.path, `changes/${work.changeName}`);
    if (existsSync(active)) return active;
    const detail = this.legacy.detail(`${source.id}/${work.changeName}`);
    return within(source.path, `changes/archive/${detail.name}`);
  }
  documents(work: Work) {
    if (['completed', 'archived'].includes(work.phase) && work.completedDocuments) return Object.keys(work.completedDocuments as object);
    try { const root = this.root(work); return ['proposal.md', 'design.md', 'tasks.md', ...markdownFiles(join(root, 'specs')).map(x => `specs/${x}`)].filter(x => textFile(within(root, x)) !== null); }
    catch (error) { if (['completed', 'archived'].includes(work.phase)) return []; throw error; }
  }
  document(id: string, path: string) {
    const work = this.get(id);
    if (typeof path !== 'string' || !(/^(proposal|design|tasks)\.md$/.test(path) || /^specs\/.+\.md$/.test(path))) throw new BadRequestException('문서 경로가 허용되지 않습니다');
    if (['completed', 'archived'].includes(work.phase) && work.completedDocuments) {
      const saved = (work.completedDocuments as Record<string, { path: string; content: string; version: string }>)[path];
      if (!saved) throw new NotFoundException('저장된 문서가 없습니다'); return saved;
    }
    const content = textFile(within(this.root(work), path));
    if (content === null) throw new NotFoundException('문서가 없습니다');
    return { path, content, version: hash(content) };
  }
  saveDocument(id: string, body: any) {
    if (!body || typeof body.content !== 'string' || body.content.length > 2000000 || typeof body.version !== 'string') throw new BadRequestException('Invalid document');
    const doc = this.document(id, body.path), work = this.get(id);
    if (['completed', 'archived'].includes(work.phase)) throw new ConflictException('완료·보관 문서는 바로 수정할 수 없습니다. 수정 업무를 다시 열어 주세요.');
    const release = projectCoordinator(this.store).acquire(work.executionPath ? this.execution.executionPath(work) : work.projectPath);
    try {
    if (doc.version !== body.version) throw new ConflictException({ error: '문서가 변경되었습니다. 최신 내용과 초안을 비교해 주세요.', latest: doc });
    this.store.record(randomUUID(), id, 'document-history', { path: body.path, before: doc.content, version: doc.version, actor: 'user', createdAt: new Date().toISOString() });
    const path = within(this.root(work), body.path); mkdirSync(dirname(path), { recursive: true }); atomicWrite(path, body.content);
    work.reviewedVersion = null; this.store.save(work); this.store.event(id, 'document-saved', { path: body.path, version: hash(body.content) }); this.legacy.updates.next();
    return this.document(id, body.path);
    } finally { release(); }
  }
  planVersion(work: Work) { return hash(this.documents(work).map(path => `${path}\n${this.document(work.id, path).content.replace(/- \[[xX ]\]/g, '- [ ]')}`).join('\n')); }
  async action(id: string, body: any) {
    const work = this.get(id);
    if (['isolate-workspace', 'apply-changes', 'archive'].includes(body?.action)) projectCoordinator(this.store).assertWorkCanStart(work);
    if (body?.action === 'guided-review') return this.startGuidedReview(id);
    if (body?.action === 'review') {
      if (['completed', 'archived'].includes(work.phase)) throw new ConflictException('완료된 업무는 수정 단계로 먼저 열어 주세요');
      if (!['idle', 'interrupted', 'failed'].includes(work.state)) throw new ConflictException('연결 또는 실행 중에는 검토를 확정할 수 없습니다');
      const docs = this.documents(work);
      if (!['proposal.md', 'design.md', 'tasks.md'].every(x => docs.includes(x)) || !docs.some(x => x.startsWith('specs/'))) throw new ConflictException('계획 문서가 준비되지 않았습니다');
      work.reviewedVersion = this.planVersion(work); if (['planning', 'reviewed'].includes(work.phase)) work.phase = 'reviewed'; this.store.save(work); this.store.event(id, 'reviewed', { version: work.reviewedVersion }); return work;
    }
    if (body?.action === 'implement') {
      projectCoordinator(this.store).assertWorkCanStart(work);
      if (!['idle', 'interrupted', 'failed'].includes(work.state)) throw new ConflictException('실행·연결 중에는 구현을 중복 시작할 수 없습니다');
      if (!work.reviewedVersion || work.reviewedVersion !== this.planVersion(work)) throw new ConflictException('최신 문서를 먼저 검토해 주세요');
      if (this.store.records(id, 'question').some(unresolvedQuestion)) throw new ConflictException('미해결 질문이 있습니다');
      this.execution.prepare(work);
      return this.codex.send(id, '사용자가 최신 문서 검토를 완료하고 구현 시작을 명시적으로 요청했다. 이 변경의 명세·설계·tasks.md에 따라 실제 구현을 진행한다. 불명확한 부분은 질문하고 같은 대화에서 수정한다. 작업을 수행하고 검증한 근거를 기록한다.', 'implementation');
    }
    if (body?.action === 'plan') return this.codex.send(id, '이 업무의 아이디어와 대화를 바탕으로 OpenSpec 제안서·설계·명세·작업 목록을 작성하거나 수정한다. 사용자와 문답하며 초안을 반복해서 수정하고 제품 코드는 구현하지 않는다.', 'planning');
    if (body?.action === 'isolate-workspace') {
      if (body.confirmed !== true || !['implementation', 'verification'].includes(work.phase) || !['idle', 'failed', 'interrupted'].includes(work.state) || !work.reviewedVersion || work.reviewedVersion !== this.planVersion(work) || this.store.records(id, 'question').some(unresolvedQuestion)) throw new ConflictException('최신 계획 검토와 명시적 격리 전환 요청이 필요합니다');
      this.execution.prepare(work, true); this.store.event(id, 'workspace-isolated', { baseline: 'transition-time' }); return work;
    }
    if (body?.action === 'reopen') { if (work.phase !== 'completed' || work.state !== 'idle') throw new ConflictException('완료된 업무만 다시 열 수 있습니다'); work.phase = 'verification'; this.store.save(work); return work; }
    if (body?.action === 'apply-changes') {
      if (body.confirmed !== true || work.phase !== 'verification' || work.state !== 'idle' || work.reviewedVersion !== this.planVersion(work)) throw new ConflictException('검증·최신 계획 검토·명시적 원본 반영 요청이 필요합니다');
      this.requireVerifications(work);
      const report = this.execution.apply(work);
      this.store.event(id, 'changes-applied', { source: report.source }); this.legacy.updates.next(); return work;
    }
    if (body?.action === 'complete') {
      if (body.confirmed !== true || work.state !== 'idle' || work.phase !== 'verification' || !work.reviewedVersion || work.reviewedVersion !== this.planVersion(work)) throw new ConflictException('최신 계획 검토·검증 결과·사용자 확인이 필요합니다');
      const tasks = this.document(id, 'tasks.md').content.match(/^\s*-\s+\[([^\]]*)\]/gm) || [];
      if (!tasks.length || tasks.some(task => !/\[\s*[xX]\s*\]/.test(task)) || this.store.records(id, 'question').some(unresolvedQuestion)) throw new ConflictException('작업 또는 질문이 남아 있습니다');
      const snapshot = this.execution.snapshot(work);
      this.requireVerifications(work, snapshotRevision(snapshot));
      work.completedDocuments = Object.fromEntries(this.documents(work).map(path => [path, this.document(id, path)]));
      this.execution.freeze(work, snapshot); this.store.event(id, 'completed', { confirmed: true }); this.legacy.updates.next(); return work;
    }
    if (body?.action === 'archive') {
      if (work.phase !== 'completed') throw new ConflictException('완료 확인 후 보관할 수 있습니다');
      const result = await this.openspec.run(work.projectPath, ['archive', work.changeName, '--yes']);
      this.store.event(id, 'archive-result', result);
      if (!result.ok) throw new ConflictException({ error: '보관에 실패했습니다. 결과를 확인하고 재시도해 주세요', result });
      if (existsSync(within(this.legacy.source(work.sourceId).path, `changes/${work.changeName}`)) || this.legacy.detail(`${work.sourceId}/${work.changeName}`).status !== 'archived') throw new ConflictException('보관 명령 이후 파일 이동을 확인하지 못했습니다. 결과를 확인하고 재시도해 주세요');
      work.archiveName = this.legacy.detail(`${work.sourceId}/${work.changeName}`).name;
      work.phase = 'archived'; this.store.save(work); this.legacy.updates.next(); return work;
    }
    throw new BadRequestException('알 수 없는 동작입니다');
  }
  private requireVerifications(work: Work, revision?: string) {
    new FileResults(this.store).assertSourcePlan(work);
    if (this.store.records(work.id, 'question').some(unresolvedQuestion)) throw new ConflictException('미해결 질문이 있습니다');
    const commands = this.execution.commands(work), results = this.execution.results(work, revision);
    if (!commands.length || commands.some(command => { const result = results.filter(r => r.commandId === command.id).at(-1); return !result || result.status !== 'passed' || !result.fresh; })) throw new ConflictException('모든 필수 검증이 최신 버전에서 통과해야 합니다');
  }
  private async startGuidedReview(id: string) {
    const validate = () => {
      const work = this.get(id);
      if (['completed', 'archived'].includes(work.phase)) throw new ConflictException('완료된 업무는 수정 단계로 먼저 열어 주세요');
      if (!['idle', 'interrupted', 'failed'].includes(work.state)) throw new ConflictException('현재 실행이나 연결을 마친 뒤 사용자 검토를 진행해 주세요');
      if (!capabilities(workTool(work)).questions) throw new ConflictException('이 도구는 구조화 질문을 지원하지 않습니다');
      if (this.store.records(id, 'question').some(unresolvedQuestion)) throw new ConflictException('남아 있는 질문에 먼저 답변해 주세요');
      return work;
    };
    if (this.guidedReviewStarting.has(id)) throw new ConflictException('사용자 검토를 시작하는 중입니다');
    const work = validate();
    this.guidedReviewStarting.add(id);
    try {
      const result = await this.review.read(this.root(work));
      validate();
      if (result.errors.length) throw new ConflictException('검토 문서를 모두 읽지 못했습니다. 문서를 확인한 뒤 다시 시도해 주세요');
      if (!result.items.length) throw new ConflictException('사용자 검토 항목이 없습니다. AI와 계획 작성·수정에서 검토할 내용을 먼저 정리해 주세요');
      return await this.codex.send(id, guidedReviewInstructions(result.items), 'planning');
    } finally { this.guidedReviewStarting.delete(id); }
  }
}
