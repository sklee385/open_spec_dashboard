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
import { BrowserService } from '../browser/browser.service';
import { reconcileArchive } from './archive-state';
import { WorkspaceService } from './workspace.service';
import { bindReviewedPlan, fullReviewedPlan } from './reviewed-plan';
import { allowedWorkDocument, corePlanDocument, workDocumentList, workDocumentPath } from './document-list';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
@Injectable()
export class WorkService {
  private creating = new Map<string, Promise<Work>>();
  private guidedReviewStarting = new Set<string>();
  constructor(@Inject(WorkStore) readonly store: WorkStore, @Inject(LegacyService) readonly legacy: LegacyService,
    @Inject(AiToolService) readonly codex: AiToolService, @Inject(OpenSpecService) readonly openspec: OpenSpecService,
    @Inject(ExecutionService) readonly execution: ExecutionService, @Inject(AiToolConfigService) readonly tools: AiToolConfigService,
    @Inject(ReviewService) readonly review: ReviewService, @Inject(BrowserService) readonly browser: BrowserService) {}
  list(): Work[] { return this.store.list().map(work => {
    const source = this.legacy.sources().find(source => source.id === work.sourceId && source.valid && dirname(source.path) === work.projectPath);
    return source ? reconcileArchive(this.store, work, source.path) : work;
  }); }
  get(id: string): Work {
    const work = this.store.get(id);
    if (!work) throw new NotFoundException('업무를 찾을 수 없습니다');
    if (work.phase === 'archived') return work;
    const source = this.legacy.sources().find(source => source.id === work.sourceId && source.valid && dirname(source.path) === work.projectPath);
    if (source) {
      const restored = reconcileArchive(this.store, work, source.path);
      if (restored.phase === 'archived') return restored;
    }
    if (work.phase === 'completed') return work;
    const current = this.legacy.source(work.sourceId);
    if (dirname(current.path) !== work.projectPath) throw new ConflictException('프로젝트 경로가 변경되었습니다');
    return work;
  }
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
      const current = this.get(existing.id);
      if (current.phase !== 'archived') this.preserveIdeas(current);
      return current;
    }
    const idea = body.ideaId ? this.legacy.ideas().find(x => x.id === body.ideaId && x.sourceId === source.id) : null;
    if (body.ideaId && !idea) throw new BadRequestException('아이디어를 찾을 수 없습니다');
    if (!existsSync(within(source.path, `changes/${body.changeName}`))) {
      if (!idea) throw new NotFoundException('변경이 없습니다');
      const release = projectCoordinator(this.store).acquireOperation({ kind: 'documents', root: dirname(source.path), changeName: body.changeName });
      try {
      const context = await this.openspec.run(dirname(source.path), ['context', '--json']);
      if (!context.ok || resolve(context.json?.root?.path || '') !== resolve(dirname(source.path))) throw new ConflictException('OpenSpec 루트가 등록 프로젝트와 일치하지 않습니다');
      const result = await this.openspec.run(dirname(source.path), ['new', 'change', body.changeName]);
      if (!result.ok) throw new ConflictException({ error: '변경 생성에 실패했습니다. 아이디어를 보존했습니다.', result });
      } finally { release(); }
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
      const release = projectCoordinator(this.store).acquireOperation({ kind: 'workspace', root: work.projectPath });
      try {
      const idea = this.legacy.ideas().find(idea => idea.id === id)!;
      mkdirSync(dirname(destination), { recursive: true }); renameSync(from, destination);
      this.store.event(work.id, 'source-idea', { title: idea.title, description: idea.description, id }); this.legacy.updates.next();
      } finally { release(); }
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
    if (new WorkspaceService(this.store).hasSpace(work) && !['completed', 'archived'].includes(work.phase)) return within(this.execution.executionPath(work), `openspec/changes/${work.changeName}`);
    const source = this.legacy.source(work.sourceId), active = within(source.path, `changes/${work.changeName}`);
    if (existsSync(active)) return active;
    const detail = this.legacy.detail(`${source.id}/${work.changeName}`);
    return within(source.path, `changes/archive/${detail.name}`);
  }
  documents(work: Work) {
    if (['completed', 'archived'].includes(work.phase) && work.completedDocuments) return Object.keys(work.completedDocuments as object);
    try { return this.documentsAtRoot(work, this.root(work)); }
    catch (error) { if (['completed', 'archived'].includes(work.phase)) return []; throw error; }
  }
  private documentsAtRoot(work: Work, root: string) {
    return workDocumentList(root, work.workspace?.kind === 'git-worktree');
  }
  private documentContent(root: string, path: string) {
    const content = textFile(workDocumentPath(root, path));
    if (content === null) throw new NotFoundException('문서가 없습니다');
    return content;
  }
  document(id: string, path: string) {
    const work = this.get(id);
    if (!allowedWorkDocument(path, work.workspace?.kind === 'git-worktree')) throw new BadRequestException('문서 경로가 허용되지 않습니다');
    if (['completed', 'archived'].includes(work.phase) && work.completedDocuments) {
      const saved = (work.completedDocuments as Record<string, { path: string; content: string; version: string }>)[path];
      if (!saved) throw new NotFoundException('저장된 문서가 없습니다'); return saved;
    }
    const root = this.root(work);
    const content = this.documentContent(root, path);
    return { path, content, version: hash(content) };
  }
  saveDocument(id: string, body: any) {
    if (!body || typeof body.content !== 'string' || body.content.length > 2000000 || typeof body.version !== 'string') throw new BadRequestException('Invalid document');
    const doc = this.document(id, body.path), work = this.get(id);
    if (['completed', 'archived'].includes(work.phase)) throw new ConflictException('완료·보관 문서는 바로 수정할 수 없습니다. 수정 업무를 다시 열어 주세요.');
    const release = projectCoordinator(this.store).acquireOperation({ kind: 'documents', root: this.execution.queryPath(work), changeName: work.changeName });
    try {
    if (doc.version !== body.version) throw new ConflictException({ error: '문서가 변경되었습니다. 최신 내용과 초안을 비교해 주세요.', latest: doc });
    this.store.record(randomUUID(), id, 'document-history', { path: body.path, before: doc.content, version: doc.version, actor: 'user', createdAt: new Date().toISOString() });
    const path = within(this.root(work), body.path); mkdirSync(dirname(path), { recursive: true }); atomicWrite(path, body.content);
    if (body.path !== 'verification.md') work.reviewedVersion = null;
    this.store.save(work); this.store.event(id, 'document-saved', { path: body.path, version: hash(body.content) }); this.legacy.updates.next();
    return this.document(id, body.path);
    } finally { release(); }
  }
  planVersion(work: Work, validatedRoot?: string) {
    if (work.workspace?.kind === 'git-worktree' && !['completed', 'archived'].includes(work.phase)) {
      const expected = JSON.stringify(this.get(work.id));
      const project = validatedRoot ?? this.execution.queryPath(work), root = within(project, `openspec/changes/${work.changeName}`);
      const legacy = hash(this.documentsAtRoot(work, root).filter(corePlanDocument).map(path => `${path}\n${this.documentContent(root, path).replace(/- \[[xX ]\]/g, '- [ ]')}`).join('\n'));
      const version = bindReviewedPlan(work, project, legacy);
      // This proof belongs only to this synchronous read; every later action revalidates.
      const latest = this.get(work.id);
      if (JSON.stringify(latest) !== expected || !validatedRoot && this.execution.queryPath(latest) !== project) throw new ConflictException('문서를 읽는 중 업무 공간이 변경되었습니다');
      return version;
    }
    const legacy = hash(this.documents(work).filter(corePlanDocument).map(path => `${path}\n${this.document(work.id, path).content.replace(/- \[[xX ]\]/g, '- [ ]')}`).join('\n'));
    return bindReviewedPlan(work, this.execution.queryPath(work), legacy);
  }
  async action(id: string, body: any, gitComplete?: (work: Work, operation: 'complete' | 'archive') => Promise<Work>) {
    const work = this.get(id);
    if (body?.action === 'archive' && work.phase === 'archived') return work;
    if (['isolate-workspace', 'apply-changes', 'archive'].includes(body?.action)) projectCoordinator(this.store).assertWorkCanStart(work);
    if (body?.action === 'guided-review') return this.startGuidedReview(id);
    if (body?.action === 'review') {
      if (['completed', 'archived'].includes(work.phase)) throw new ConflictException('완료된 업무는 수정 단계로 먼저 열어 주세요');
      if (!['idle', 'interrupted', 'failed'].includes(work.state)) throw new ConflictException('연결 또는 실행 중에는 검토를 확정할 수 없습니다');
      const docs = this.documents(work);
      if (!['proposal.md', 'design.md', 'tasks.md'].every(x => docs.includes(x)) || !docs.some(x => x.startsWith('specs/'))) throw new ConflictException('계획 문서가 준비되지 않았습니다');
      work.reviewedPlanRevision = fullReviewedPlan(work, this.execution.queryPath(work)); work.reviewedVersion = this.planVersion(work); if (['planning', 'reviewed'].includes(work.phase)) work.phase = 'reviewed'; this.store.save(work); this.store.event(id, 'reviewed', { version: work.reviewedVersion }); return work;
    }
    if (body?.action === 'implement') {
      projectCoordinator(this.store).assertActivityCanStart(work, 'implementation');
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
      const expectedWork = JSON.stringify(work), before = this.execution.snapshot(work);
      await this.requireVerifications(work);
      this.assertVerificationUnchanged(work, expectedWork, before);
      const report = this.execution.apply(work);
      this.store.event(id, 'changes-applied', { source: report.source }); this.legacy.updates.next(); return work;
    }
    if (body?.action === 'complete') {
      if (body.confirmed !== true || work.state !== 'idle' || work.phase !== 'verification' || !work.reviewedVersion || work.reviewedVersion !== this.planVersion(work)) throw new ConflictException('최신 계획 검토·검증 결과·사용자 확인이 필요합니다');
      const tasks = this.document(id, 'tasks.md').content.match(/^\s*-\s+\[([^\]]*)\]/gm) || [];
      if (!tasks.length || tasks.some(task => !/\[\s*[xX]\s*\]/.test(task)) || this.store.records(id, 'question').some(unresolvedQuestion)) throw new ConflictException('작업 또는 질문이 남아 있습니다');
      if (work.workspace?.kind === 'git-worktree') {
        if (!gitComplete) throw new ConflictException('Git 완료의 적용 근거 확인 경로가 필요합니다');
        return gitComplete(work, 'complete');
      }
      const snapshot = this.execution.snapshot(work);
      const expectedWork = JSON.stringify(work);
      await this.requireVerifications(work, snapshotRevision(snapshot));
      this.assertVerificationUnchanged(work, expectedWork, snapshot);
      const latestTasks = this.document(id, 'tasks.md').content.match(/^\s*-\s+\[([^\]]*)\]/gm) || [];
      if (!latestTasks.length || latestTasks.some(task => !/\[\s*[xX]\s*\]/.test(task))) throw new ConflictException('검증 확인 중 작업 목록이 변경되었습니다');
      work.completedDocuments = Object.fromEntries(this.documents(work).map(path => [path, this.document(id, path)]));
      this.execution.freeze(work, snapshot); this.store.event(id, 'completed', { confirmed: true }); this.legacy.updates.next(); return work;
    }
    if (body?.action === 'archive') {
      if (work.phase !== 'completed') throw new ConflictException('완료 확인 후 보관할 수 있습니다');
      if (body.confirmed !== true) throw new ConflictException('원본 보관을 명시적으로 확인해 주세요');
      if (gitComplete) return gitComplete(work, 'archive');
      if (work.workspace?.kind === 'git-worktree') throw new ConflictException('Git 보관의 실제 상태 확인 경로가 필요합니다');
      const release = projectCoordinator(this.store).acquireOperation({ kind: 'integration', root: work.projectPath });
      try {
      const result = await this.openspec.run(work.projectPath, ['archive', work.changeName, '--yes']);
      this.store.event(id, 'archive-result', result);
      if (!result.ok) throw new ConflictException({ error: '보관에 실패했습니다. 결과를 확인하고 재시도해 주세요', result });
      if (existsSync(within(this.legacy.source(work.sourceId).path, `changes/${work.changeName}`)) || this.legacy.detail(`${work.sourceId}/${work.changeName}`).status !== 'archived') throw new ConflictException('보관 명령 이후 파일 이동을 확인하지 못했습니다. 결과를 확인하고 재시도해 주세요');
      work.archiveName = this.legacy.detail(`${work.sourceId}/${work.changeName}`).name;
      work.phase = 'archived'; this.store.save(work); this.legacy.updates.next(); return work;
      } finally { release(); }
    }
    throw new BadRequestException('알 수 없는 동작입니다');
  }
  private assertVerificationUnchanged(work: Work, expectedWork: string, snapshot: ReturnType<ExecutionService['snapshot']>, validatedRoot?: string) {
    if (JSON.stringify(this.get(work.id)) !== expectedWork || JSON.stringify(this.execution.snapshot(work, validatedRoot)) !== JSON.stringify(snapshot) || this.store.records(work.id, 'question').some(unresolvedQuestion) || work.reviewedVersion !== this.planVersion(this.get(work.id), validatedRoot)) throw new ConflictException('검증 확인 중 업무·소스·계획 또는 질문이 변경되었습니다. 다시 확인해 주세요');
  }
  async integrationReadiness(id: string, reviewedVersion: string, validatedRoot?: string) {
    const work = this.get(id);
    if (work.workspace?.kind !== 'git-worktree' || work.phase !== 'verification' || work.state !== 'idle' || !work.reviewedVersion || work.reviewedVersion !== reviewedVersion || work.reviewedVersion !== this.planVersion(work, validatedRoot)) throw new ConflictException('검증 단계의 업무·최신 계획 검토·실행 종료를 먼저 확인해 주세요.');
    const expected = JSON.stringify(work), snapshot = this.execution.snapshot(work, validatedRoot), sourceRevision = snapshotRevision(snapshot);
    await this.requireVerifications(work, sourceRevision, validatedRoot);
    this.assertVerificationUnchanged(work, expected, snapshot, validatedRoot);
    const { commands, scope } = this.execution.requiredPlan(work, undefined, validatedRoot), results = this.execution.results(work, sourceRevision, { full: scope === 'full' ? commands : [], work: scope === 'work' ? commands : [] });
    const workVerificationRefs = commands.map(command => results.filter(row => row.commandId === command.id && row.scope === scope).at(-1)!.id);
    if (work.browserScenario) workVerificationRefs.push(this.store.records(id, 'browser-verification').at(-1)!.id);
    return { work, sourceRevision, workVerificationRefs };
  }
  private async requireVerifications(work: Work, revision?: string, validatedRoot?: string) {
    await this.browser.assertPassed(work);
    new FileResults(this.store).assertSourcePlan(work);
    if (this.store.records(work.id, 'question').some(unresolvedQuestion)) throw new ConflictException('미해결 질문이 있습니다');
    const { commands, scope } = this.execution.requiredPlan(work, undefined, validatedRoot), results = this.execution.results(work, revision, { full: scope === 'full' ? commands : [], work: scope === 'work' ? commands : [] });
    if (!commands.length || commands.some(command => { const result = results.filter(r => r.commandId === command.id && r.scope === scope).at(-1); return !result || result.status !== 'passed' || !result.fresh; })) throw new ConflictException('소스·계획·명령·실행 환경 변경을 확인하고 모든 필수 검증이 최신 버전에서 통과해야 합니다');
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
