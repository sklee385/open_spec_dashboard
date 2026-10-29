import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { Work, WorkStore } from './store';
import type { WorkspaceSettingsService } from './workspace-settings.service';
import { WorkspaceService } from './workspace.service';
import { WorktreeManager } from './worktree-manager';
import { FileResults } from './file-results';
import { unresolvedQuestion } from '../codex/questions';
import { projectCoordinator } from '../projects/coordinator';
interface Options { enabled?: () => boolean; manager?: WorktreeManager; }
/** Explicit staged entry point. Production's default creation stays disabled until combined validation. */
export class WorkspaceProvisioner {
  private manager: WorktreeManager;
  private spaces: WorkspaceService;
  private pending = new Map<string, { fingerprint: string; promise: Promise<ReturnType<WorkspaceProvisioner['status']>> }>();
  constructor(private store: WorkStore, private settings: WorkspaceSettingsService, private options: Options = {}) {
    this.manager = options.manager ?? new WorktreeManager({ store });
    this.spaces = new WorkspaceService(store, { protectedPaths: () => settings.protectedPaths() });
  }
  private enabled() { return this.options.enabled?.() ?? process.env.OPENSPEC_WORKTREE_EXPERIMENTAL === '1'; }
  async close() { return this.manager.close(); }
  status(work: Work) {
    const location = this.spaces.describe(work);
    let available = false;
    try { this.spaces.path(work); available = true; } catch { /* No original fallback or implied success. */ }
    return { ...(location ?? { kind: null, legacy: false, status: 'unprepared', executionPath: null, rootId: null, workspaceId: null }), available, experimentalEnabled: this.enabled(), branch: work.workspace?.branch ?? null, baseCommit: work.workspace?.baseCommit ?? null, workspaceBaselineCommit: work.workspace?.workspaceBaselineCommit ?? null,
      preparation: this.store.records(work.id, 'workspace-preparation').map(row => ({ stage: row.stage, status: row.status, error: row.error, endedAt: row.endedAt })) };
  }
  async preview(work: Work, selectedBranch?: string) {
    if (this.spaces.hasSpace(work)) {
      const creation = this.store.records(work.id, 'workspace-creation')[0];
      if (work.workspace?.kind === 'git-worktree' && work.workspace.status !== 'ready' && creation && this.store.records(work.id, 'workspace-documents')[0]?.status !== 'copied') {
        const git = await this.manager.inspect(work.projectPath, creation.selectedBranch);
        const documents = git.state === 'ready' && git.head === creation.sourceHead && git.baseCommit === creation.baseCommit ? await this.manager.previewDocuments(work, creation.selectedBranch) : null;
        return { ...this.status(work), git, documents, projectId: work.workspace.projectId };
      }
      return { ...this.status(work), git: null, documents: null, projectId: work.workspace?.projectId ?? null };
    }
    const git = await this.manager.inspect(work.projectPath, selectedBranch);
    const documents = git.state === 'ready' && work.reviewedVersion ? await this.manager.previewDocuments(work, git.selectedBranch!) : null;
    return { ...this.status(work), git, documents, projectId: createHash('sha256').update(realpathSync(work.projectPath)).digest('hex') };
  }
  prepare(work: Work, body: any) {
    // A renewed confirmation token may refer to the same immutable request.
    // Its document/exclusion basis is checked separately below.
    const fingerprint = createHash('sha256').update(JSON.stringify(body ? { ...body, previewToken: undefined } : null)).digest('hex'), active = this.pending.get(work.id);
    if (active) { if (active.fingerprint !== fingerprint) throw new ConflictException('다른 공간 준비 요청이 진행 중입니다.'); return active.promise; }
    const release = projectCoordinator(this.store).acquireOperation({ kind: 'documents', root: work.projectPath, changeName: work.changeName });
    const promise = this.perform(work, body, fingerprint).finally(() => { this.pending.delete(work.id); release(); });
    this.pending.set(work.id, { fingerprint, promise }); return promise;
  }
  private async perform(work: Work, body: any, fingerprint: string) {
    const latest = this.store.get(work.id); if (!latest) throw new ConflictException('업무가 없습니다.'); Object.assign(work, latest);
    // Existing copy paths never depend on a newly selected root or the feature gate.
    if (this.spaces.hasSpace(work) && !work.workspace) { this.spaces.path(work); return this.status(work); }
    if (!this.enabled()) throw new ConflictException('결합 검증 전 신규 공간 생성은 기본 활성화하지 않습니다.');
    if (!body || typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(body.requestKey) || !work.reviewedVersion || !['reviewed', 'implementation', 'verification'].includes(work.phase) || !['idle', 'interrupted', 'failed'].includes(work.state) || this.store.records(work.id, 'question').some(unresolvedQuestion)) throw new ConflictException('최신 계획 검토·대기 해소·명시적 준비 요청이 필요합니다.');
    const previous = this.store.records(work.id, 'workspace-request')[0];
    if (previous && (previous.requestKey !== body.requestKey || previous.fingerprint !== fingerprint)) throw new ConflictException('기존 생성 요청과 내용이 다릅니다. 고정 공간을 먼저 복구해 주세요.');
    if (work.workspace?.status === 'ready') { this.spaces.path(work); return this.status(work); }
    if (work.workspace && work.workspace.kind === 'copy' || previous?.status === 'failed' && !work.workspace) throw new ConflictException('실패한 복사 공간과 잔여를 확인해 주세요. 새 공간으로 자동 재시도하지 않습니다.');
    if (this.store.records(work.id, 'baseline').length) throw new ConflictException('기존 공유 업무는 명시적 격리 전환 절차를 사용해 주세요.');
    const selectedBranch = previous?.selectedBranch ?? body.selectedBranch;
    const git = await this.manager.inspect(work.projectPath, selectedBranch);
    if (git.state !== 'ready' && !git.copyEligible) throw new ConflictException(git.reason ?? 'Git 준비에 실패했습니다. 복사로 전환하지 않습니다.');
    if (git.copyEligible && body.confirmed !== true) throw new ConflictException('비Git/초기 커밋 없음의 복사 방식을 확인해 주세요.');
    const preview = this.store.records(work.id, 'workspace-document-preview')[0];
    const needsDocuments = !git.copyEligible && this.store.records(work.id, 'workspace-documents')[0]?.status !== 'copied';
    if (needsDocuments && (!preview || body.excludedConfirmed !== true || body.previewToken !== preview.confirmationToken || preview.expiresAt <= Date.now() || preview.reviewedVersion !== work.reviewedVersion || preview.sourceHead !== git.head || preview.baseCommit !== git.baseCommit || preview.selectedBranch !== git.selectedBranch || !body.policy)) throw new ConflictException('최신 제외 목록과 준비 정책의 확인이 필요합니다.');
    const documentBasis = needsDocuments ? JSON.stringify([preview.documentRevision, preview.excludedRevision, preview.reviewedVersion, preview.sourceHead, preview.baseCommit, preview.selectedBranch]) : previous?.documentBasis;
    if (previous?.documentBasis && documentBasis !== previous.documentBasis) throw new ConflictException('고정 공간의 검토 문서·제외 목록 기준이 변경되었습니다. 별도 복구가 필요합니다.');
    this.store.record(`${work.id}:workspace-request`, work.id, 'workspace-request', { ...previous, requestKey: body.requestKey, fingerprint, documentBasis, selectedBranch: git.selectedBranch, kind: git.copyEligible ? 'copy' : 'git-worktree', status: 'preparing' });
    try {
      if (git.copyEligible) new FileResults(this.store, this.spaces).prepareManagedCopy(work, this.settings);
      else {
        if (body.excludedConfirmed !== true || typeof body.previewToken !== 'string' || !body.policy) throw new ConflictException('제외 목록과 프로젝트별 로컬 준비 목록을 명시적으로 확인해 주세요.');
        const creation = this.store.records(work.id, 'workspace-creation')[0];
        await this.manager.create(work, this.settings, { requestKey: body.requestKey, selectedBranch: creation?.selectedBranch ?? git.selectedBranch!, baseCommit: creation?.baseCommit ?? git.baseCommit!, sourceHead: creation?.sourceHead ?? git.head! });
        if (this.store.records(work.id, 'workspace-documents')[0]?.status !== 'copied') await this.manager.importDocuments(work, this.settings, { confirmationToken: body.previewToken, documentRevision: preview?.documentRevision, excludedRevision: preview?.excludedRevision, excludedConfirmed: true });
        if (this.store.records(work.id, 'workspace-baseline')[0]?.status !== 'committed') await this.manager.commitDocuments(work, this.settings);
        await this.manager.prepareLocal(work, this.settings, body.policy);
        await this.manager.verify(work, this.settings);
        if (this.store.records(work.id, 'workspace-local-process').some(record => record.status !== 'passed') || this.store.records(work.id, 'workspace-preparation').some(record => record.status === 'failed')) throw new Error('준비 프로세스 또는 단계의 실제 완료 확인이 필요합니다.');
        work.workspace!.status = 'ready'; work.workspace!.error = undefined; this.store.save(work);
        this.spaces.path(work);
      }
      work.error = undefined; delete work.errorCode; work.state = 'idle'; this.store.save(work);
      this.store.record(`${work.id}:workspace-request`, work.id, 'workspace-request', { ...this.store.records(work.id, 'workspace-request')[0], status: 'ready' });
      this.store.event(work.id, 'workspace-prepared', this.status(work)); return this.status(work);
    } catch (error: any) {
      if (work.workspace && work.workspace.status !== 'recovery-required') { work.workspace.status = 'failed'; work.workspace.error = error.message; }
      work.state = 'failed'; work.error = error.message; work.errorCode = 'workspace-preparation-failed'; this.store.save(work);
      this.store.record(`${work.id}:workspace-request`, work.id, 'workspace-request', { ...this.store.records(work.id, 'workspace-request')[0], status: 'failed', error: error.message }); throw error;
    }
  }
}
