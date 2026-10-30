import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { WorkStore, type Work, type IntegrationRequest } from './store';
import { WorkService } from './work.service';
import { IntegrationApplyPreflight } from './integration-apply-preflight';
import { IntegrationApply } from './integration-apply';
import { liveApply, terminatedApply } from './integration-apply-state';
import { requireCompletionProof } from './git-completion-proof';
import { projectCoordinator } from '../projects/coordinator';
import { DesktopLifecycle } from '../desktop/lifecycle';
import { desktopHealth } from '../desktop/health';
import { unresolvedQuestion } from '../codex/questions';
import { readGitSync } from '../projects/git-runner';
import { readGitBlobsSync } from '../projects/git-blobs';
import { workspaceResourcePath } from './workspace-file-policy';
import { differences, type FileState, type Snapshot } from './file-results';
import { CompletedResults } from './completed-results';
import { inspectArchiveSource, observeArchiveMove } from './archive-observation';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Completion consumes a historical application; it never reruns verification or Git mutation. */
@Injectable()
export class GitCompletionService {
  constructor(@Inject(WorkStore) private store: WorkStore, @Inject(WorkService) private works: WorkService,
    @Inject(IntegrationApplyPreflight) private preflight: IntegrationApplyPreflight, @Inject(IntegrationApply) private applying: IntegrationApply,
    @Inject(DesktopLifecycle) private lifecycle: DesktopLifecycle) {}
  action(id: string, body: any) { return this.works.action(id, body, (work, operation) => operation === 'archive' ? this.archive(work) : this.complete(work)); }
  private records(work: Work) {
    return [this.store.get(work.id), this.store.integrationRequests().filter(row => row.workId === work.id), ...['integration-apply', 'workspace-git-intent', 'verification', 'candidate-verification', 'browser-verification', 'question', 'queued-message'].map(kind => this.store.records(work.id, kind))];
  }
  private idle(work: Work) {
    if (work.state !== 'idle' || desktopHealth(this.store).runtime(work) !== 'inactive' || liveApply(this.store, work.id) || this.store.records(work.id, 'question').some(unresolvedQuestion) || this.store.records(work.id, 'queued-message').some(row => ['queued', 'dispatching', 'uncertain'].includes(row.status)) || ['verification', 'candidate-verification', 'browser-verification'].some(kind => this.store.records(work.id, kind).some(row => row.status === 'running'))) throw new ConflictException('업무의 실행·질문·종료 미확인 상태를 먼저 확인해 주세요');
  }
  private selected(work: Work) {
    const request = this.store.integrationRequests().filter(row => row.workId === work.id).at(-1);
    const row = this.store.records(work.id, 'integration-apply').filter(row => row.candidateId === request?.candidateId).at(-1);
    const intent = this.store.records(work.id, 'workspace-git-intent').find(item => item.id === row?.intentId);
    if (!request || request.status !== 'applied' || !row || row.status !== 'applied' || row.applied !== true || row.requestId !== request.id || (request as any).applyAttemptId !== row.id || row.candidateEpoch !== (request.candidateMutationVersion ?? null) || row.candidateCommit !== request.candidateCommit || row.appliedCommit !== request.candidateCommit || request.appliedCommit !== row.appliedCommit || row.targetHead !== request.targetHead || row.targetBranch !== request.targetBranch || !terminatedApply(row, intent) || intent.status !== 'passed') throw new ConflictException('최신 후보의 실제 반영과 소유 실행 종료를 먼저 확정해 주세요');
    return { request, row };
  }
  private report(work: Work, request: IntegrationRequest) {
    const tree = (commit: string) => {
      const result = new Map<string, { mode: string; blob: string; size: number }>();
      for (const line of readGitSync(request.projectPath, ['-c', 'core.fsmonitor=false', 'ls-tree', '-r', '-l', '-z', commit]).split('\0').filter(Boolean)) {
        const match = /^(\d{6}) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(line);
        if (!match) throw new ConflictException('완료 Git tree 형식을 확인할 수 없습니다');
        if (workspaceResourcePath(work, match[4])) continue;
        if (!['100644', '100755'].includes(match[1]) || result.size >= 10000) throw new ConflictException('완료 Git tree의 형식 또는 파일 수 한도를 확인해 주세요');
        result.set(match[4], { mode: match[1], blob: match[2], size: Number(match[3]) });
      }
      return result;
    };
    const before = tree(request.targetHead), after = tree(request.candidateCommit!), paths = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path)?.blob !== after.get(path)?.blob || before.get(path)?.mode !== after.get(path)?.mode);
    const metadata = paths.flatMap(path => [before.get(path), after.get(path)].filter((entry): entry is { mode: string; blob: string; size: number } => !!entry && entry.size < 200000));
    const blobs = readGitBlobsSync(request.projectPath, metadata, (bytes): FileState => { const value = digest(bytes), binary = bytes.includes(0); return { hash: value, rawHash: value, content: binary ? null : bytes.toString('utf8'), availability: binary ? 'binary' : 'text' }; });
    const snapshot = (entries: typeof before): Snapshot => Object.fromEntries(paths.flatMap(path => {
      const entry = entries.get(path); if (!entry) return [];
      return [[path, entry.size < 200000 ? { ...blobs.get(entry.blob)!, mode: entry.mode } : { hash: `git:${entry.blob}`, rawHash: `git:${entry.blob}`, content: null, availability: 'size-limit', mode: entry.mode }]];
    }));
    return { version: 1, policyVersion: 1, workId: work.id, kind: 'git-worktree', source: 'completed', isolated: true, baseCommit: request.targetHead, revision: request.candidateCommit, application: 'applied', files: differences(snapshot(before), snapshot(after)), endedAt: new Date().toISOString(), excluded: [] };
  }
  private async complete(work: Work) {
    this.lifecycle.assertUnlocked(); this.idle(work);
    const { request, row } = this.selected(work), refs = requireCompletionProof(this.store, work, request, row), owned = this.preflight.inspectOwnership(work.id, request.candidateId);
    const expected = hash(this.records(work)), release = projectCoordinator(this.store).acquireOperation(owned.plan), settle = this.lifecycle.beginRequest('git-completion', work.id);
    try {
      const observed = await this.applying.inspectAttempt(row, request);
      if (observed.observation.state !== 'applied' || observed.observation.sideChanged !== false) throw new ConflictException('반영 이후 원본·업무·후보 상태가 변경되었습니다. 새 결과를 먼저 확인해 주세요');
      const report = this.report(work, request);
      const assertUnchanged = () => {
        if (hash(this.records(work)) !== expected) throw new ConflictException('완료 확인 중 업무·후보·적용 또는 검증 근거가 변경되었습니다');
        this.idle(work); this.preflight.inspectOwnership(work.id, request.candidateId); requireCompletionProof(this.store, work, request, row); observed.assertUnchanged();
      };
      const completed = { ...work, completedDocuments: Object.fromEntries(this.works.documents(work).map(path => [path, this.works.document(work.id, path)])) };
      this.works.execution.freeze(completed, undefined, { report, refs, integration: { candidateId: request.candidateId, targetBranch: request.targetBranch, targetHead: request.targetHead, appliedCommit: row.appliedCommit, resultCommit: request.resultCommit, attemptId: row.id }, assertUnchanged });
      this.store.event(work.id, 'completed', { confirmed: true, candidateId: request.candidateId, appliedCommit: row.appliedCommit }); this.works.legacy.updates.next(); return completed;
    } finally { release(); settle(); }
  }
  private async archive(work: Work) {
    this.lifecycle.assertUnlocked(); this.idle(work);
    const source = this.works.legacy.source(work.sourceId);
    if (dirname(source.path) !== work.projectPath) throw new ConflictException('보관 원본의 등록 경로가 변경되었습니다');
    const git = work.workspace?.kind === 'git-worktree', selected = git ? this.selected(work) : undefined;
    if (selected) {
      const retained = new CompletedResults(this.store).header(work.id);
      if (retained?.integration?.attemptId !== selected.row.id || retained.integration.appliedCommit !== selected.row.appliedCommit) throw new ConflictException('완료 캡처와 실제 적용 영수증이 다릅니다');
      requireCompletionProof(this.store, work, selected.request, selected.row);
    }
    const prior = this.store.records(work.id, 'archive-attempt').at(-1);
    if (prior && ['running', 'uncertain'].includes(prior.status)) throw new ConflictException('이전 보관 실행의 종료 또는 저장 결과를 확인할 수 없습니다. 자동 재실행하지 않습니다');
    const reviewing = prior?.status === 'needs-review' && prior.result?.ok === true && typeof prior.archiveName === 'string';
    const expectedSource = selected ? { commonDir: selected.request.commonDir, branch: selected.request.targetBranch, ...(!reviewing ? { head: selected.row.appliedCommit } : {}) } : undefined;
    const before = inspectArchiveSource(work.projectPath, expectedSource);
    if (git && before.observation.state !== 'clean') throw new ConflictException({ error: '보관 원본을 먼저 확인해 주세요', postCheck: before.observation });
    if (reviewing && selected) readGitSync(work.projectPath, ['-c', 'core.fsmonitor=false', 'merge-base', '--is-ancestor', selected.row.appliedCommit, before.observation.head!]);
    const plan = { kind: 'integration' as const, root: work.projectPath, commonDir: selected?.request.commonDir ?? before.observation.commonDir, refs: selected ? [`refs/heads/${selected.request.targetBranch}`] : [] };
    const baseline = hash([this.records(work), this.store.records(work.id, 'archive-attempt')]), release = projectCoordinator(this.store).acquireOperation(plan), settle = this.lifecycle.beginRequest('work-archive', work.id);
    try {
      if (reviewing) {
        const moved = observeArchiveMove(work, source.path);
        if (!moved || moved.archiveName !== prior.archiveName || moved.version !== prior.archiveVersion || !['clean', 'not-applicable'].includes(before.observation.state)) throw new ConflictException({ error: '보관 파일·원본 변경을 확인하고 정리한 뒤 명시적으로 다시 확인해 주세요', postCheck: before.observation });
        return this.store.transaction(() => {
          if (hash([this.records(work), this.store.records(work.id, 'archive-attempt')]) !== baseline) throw new ConflictException('보관 재확인 중 업무 또는 실행 근거가 변경되었습니다');
          this.idle(work); before.assertUnchanged();
          if (hash(observeArchiveMove(work, source.path)) !== hash(moved)) throw new ConflictException('보관 문서가 확정 직전에 변경되었습니다');
          this.store.record(prior.id, work.id, 'archive-attempt', { ...prior, status: 'archived', postCheck: before.observation, reconfirmedAt: new Date().toISOString() });
          return this.store.save({ ...work, phase: 'archived', archiveName: moved.archiveName });
        });
      }
      const id = `archive:${randomUUID()}`, intentId = `${id}:intent`, owner = randomUUID(), runGeneration = randomUUID();
      let row: any = { id, workId: work.id, status: 'running', intentId, owner, runGeneration, beforeCheck: before.observation, createdAt: new Date().toISOString(), ...(selected ? { candidateId: selected.request.candidateId, attemptId: selected.row.id, appliedCommit: selected.row.appliedCommit } : {}) };
      let intent: any = { id: intentId, scope: 'integration', root: work.projectPath, commonDir: plan.commonDir, refs: plan.refs, affectedRoots: [], stage: 'openspec-archive', status: 'running', owner, runGeneration, processTerminated: false };
      let expected = this.store.transaction(() => {
        if (hash([this.records(work), this.store.records(work.id, 'archive-attempt')]) !== baseline) throw new ConflictException('보관 시작 중 업무 또는 실행 근거가 변경되었습니다');
        this.idle(work); projectCoordinator(this.store).assertRecovery(plan); if (git) before.assertUnchanged();
        this.store.record(id, work.id, 'archive-attempt', row); this.store.record(intentId, work.id, 'workspace-git-intent', intent);
        return hash([this.records(work), this.store.records(work.id, 'archive-attempt')]);
      });
      let result: any, ended = false;
      try { result = await this.works.openspec.run(work.projectPath, ['archive', work.changeName, '--yes']); ended = Number.isInteger(result.code) && result.code >= 0 && !result.stderr?.includes('CLI 시간 초과'); }
      catch (error: any) { result = { ok: false, code: null, stdout: '', stderr: error.message }; }
      const post = inspectArchiveSource(work.projectPath, expectedSource);
      let moved: ReturnType<typeof observeArchiveMove> = null, moveError: string | undefined;
      try { moved = observeArchiveMove(work, source.path); } catch (error: any) { moveError = error.message; }
      const archived = ended && result.ok === true && !!moved && ['clean', 'not-applicable'].includes(post.observation.state);
      row = { ...row, result, processTerminated: ended, postCheck: post.observation, ...(moved ? { archiveName: moved.archiveName, archiveVersion: moved.version } : {}), ...(moveError ? { moveError } : {}), status: !ended ? 'uncertain' : !result.ok ? 'failed' : archived ? 'archived' : 'needs-review', endedAt: new Date().toISOString() };
      const saved = this.store.transaction(() => {
        if (hash([this.records(work), this.store.records(work.id, 'archive-attempt')]) !== expected) throw new ConflictException('보관 결과를 저장하는 동안 업무·실행 또는 적용 근거가 변경되었습니다');
        this.idle(work);
        if (archived) { post.assertUnchanged(); if (hash(observeArchiveMove(work, source.path)) !== hash(moved)) throw new ConflictException('보관 파일이 확정 직전에 변경되었습니다'); }
        this.store.record(id, work.id, 'archive-attempt', row); this.store.record(intentId, work.id, 'workspace-git-intent', { ...intent, status: ended ? 'passed' : 'uncertain', processTerminated: ended, resultId: id });
        this.store.event(work.id, 'archive-result', { attemptId: id, result, postCheck: row.postCheck });
        return archived ? this.store.save({ ...work, phase: 'archived', archiveName: moved!.archiveName }) : work;
      });
      this.works.legacy.updates.next();
      if (!archived) throw new ConflictException({ error: ended ? result.ok ? '보관 명령 결과를 보존했습니다. 원본 dirty·문서 이동을 정리한 뒤 명시적으로 재확인해 주세요' : '보관에 실패했습니다. 반영·완료 근거는 보존했습니다' : '보관 실행의 실제 종료를 확인할 수 없습니다. 자동 재실행하지 않습니다', archiveAttempt: row });
      return saved;
    } finally { release(); settle(); }
  }
}
