import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readGitSync } from '../projects/git-runner';
import { WorkStore, type IntegrationRequest, type Work } from './store';
import { WorkspaceSettingsService } from './workspace-settings.service';
import { WorkspaceService } from './workspace.service';
import { assertCandidateCapacity, assertPreparationCapacity } from './workspace-policy';
import { inspectWorkspacePath } from './workspace-paths';
import { preflightGitDirectoryPath } from './git-path-preflight';
import { projectCoordinator } from '../projects/coordinator';
import { ProjectResolver } from '../projects/resolver';
import type { WorkService } from './work.service';
import type { MutationAdmission } from './mutation-admission';

export interface IntegrationInput { requestKey: string; confirmed: true; targetBranch: string; expectedWorkHead: string; expectedTargetHead: string; reviewedVersion: string; }
export interface IntegrationReadiness { work: Work; sourceRevision: string; workVerificationRefs: string[]; }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = (path: string) => { const value = realpathSync(path); return process.platform === 'win32' ? value.toLowerCase() : value; };
const terminal = new Set(['applied', 'cancelled', 'removed']);
@Injectable()
export class IntegrationService {
  constructor(@Inject(WorkStore) private store: WorkStore, @Inject(WorkspaceSettingsService) private settings: WorkspaceSettingsService) {}
  parse(body: any): IntegrationInput {
    const keys = ['requestKey', 'confirmed', 'targetBranch', 'expectedWorkHead', 'expectedTargetHead', 'reviewedVersion'];
    const head = (value: unknown) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key)) || body.confirmed !== true || typeof body.requestKey !== 'string' || !body.requestKey.trim() || body.requestKey.length > 200 || typeof body.reviewedVersion !== 'string' || !body.reviewedVersion || body.reviewedVersion.length > 200 || !head(body.expectedWorkHead) || !head(body.expectedTargetHead) || typeof body.targetBranch !== 'string' || body.targetBranch.length > 200 || !body.targetBranch || body.targetBranch.startsWith('-') || /[\x00-\x20\x7f~^:?*\[\\]/.test(body.targetBranch) || body.targetBranch.includes('..') || body.targetBranch.includes('@{') || body.targetBranch.endsWith('.') || body.targetBranch.split('/').some((part: string) => !part || part.startsWith('.') || part.endsWith('.lock'))) throw new BadRequestException('명시적 통합 요청 키·대상 브랜치·HEAD·검토 버전을 확인해 주세요.');
    return Object.fromEntries(keys.map(key => [key, body[key]])) as unknown as IntegrationInput;
  }
  replay(workId: string, request: IntegrationInput): IntegrationRequest | undefined {
    const previous = this.store.integrationRequests().find(row => row.workId === workId && row.requestKey === request.requestKey);
    if (previous && previous.fingerprint !== digest([workId, request])) throw new ConflictException('같은 통합 요청 키에 다른 내용을 사용할 수 없습니다.');
    return previous;
  }
  status(workId: string) { const requests = this.store.integrationRequests().filter(row => row.workId === workId); return { requests, active: requests.find(row => !terminal.has(row.status)) ?? null }; }
  reservationPreview(works: WorkService, workId: string) {
    const work = works.get(workId);
    if (work.workspace?.kind !== 'git-worktree' || !work.reviewedVersion) throw new ConflictException('검토된 Git 업무 공간을 먼저 확인해 주세요.');
    const resolver = new ProjectResolver(works.legacy, this.store), selected = resolver.resolve(work.sourceId, workId);
    if (selected.root !== work.executionPath || !selected.boundary || !selected.commonDir || canonical(selected.commonDir) !== canonical(work.workspace.commonDir!)) throw new ConflictException('업무 Git 소유 경계가 변경되었습니다.');
    const expected = JSON.stringify(work), text = (root: string, args: string[]) => readGitSync(root, args).trim();
    const read = () => {
      if (canonical(text(work.projectPath, ['rev-parse', '--show-toplevel'])) !== canonical(work.projectPath) || canonical(text(work.projectPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== canonical(work.workspace!.commonDir!)) throw new ConflictException('원본 Git 소유 경계가 변경되었습니다.');
      const workHead = text(selected.root, ['rev-parse', '--verify', 'HEAD^{commit}']), sourceHead = text(work.projectPath, ['rev-parse', '--verify', 'HEAD^{commit}']);
      if (text(selected.root, ['symbolic-ref', 'HEAD']) !== `refs/heads/${work.workspace!.branch}`) throw new ConflictException('업무 브랜치 소유가 변경되었습니다.');
      const sourceBranch = text(work.projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branches = text(work.projectPath, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads/']).split('\n').filter(Boolean).map(line => { const [ref, commit] = line.split('\0'); return { name: ref.slice('refs/heads/'.length), commit }; }).filter(branch => branch.name !== work.workspace!.branch);
      return { workHead, sourceHead, sourceBranch: sourceBranch === 'HEAD' ? null : sourceBranch, branches, reviewedVersion: work.reviewedVersion! };
    };
    const before = read();
    resolver.resolve(work.sourceId, workId);
    if (JSON.stringify(this.store.get(workId)) !== expected || JSON.stringify(read()) !== JSON.stringify(before)) throw new ConflictException('통합 미리보기 중 원본·업무 기준이 변경되었습니다.');
    return before;
  }
  reserve(request: IntegrationInput, readiness: IntegrationReadiness, admission?: MutationAdmission): IntegrationRequest {
    const work = readiness.work, replay = this.replay(work.id, request); if (replay) return replay;
    if (JSON.stringify(this.store.get(work.id)) !== JSON.stringify(work) || work.workspace?.kind !== 'git-worktree' || work.reviewedVersion !== request.reviewedVersion) throw new ConflictException('통합 요청 확인 중 업무 또는 검토 상태가 변경되었습니다.');
    const executionPath = new WorkspaceService(this.store).path(work), space = work.workspace;
    let commonDir: string;
    try {
      const text = (root: string, args: string[]) => readGitSync(root, args).trim();
      if (canonical(text(work.projectPath, ['rev-parse', '--show-toplevel'])) !== canonical(work.projectPath)) throw new Error('project boundary');
      commonDir = realpathSync(text(work.projectPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      if (!space.commonDir || canonical(commonDir) !== canonical(space.commonDir) || text(executionPath, ['rev-parse', '--verify', 'HEAD^{commit}']) !== request.expectedWorkHead || text(work.projectPath, ['rev-parse', '--verify', `refs/heads/${request.targetBranch}^{commit}`]) !== request.expectedTargetHead || request.targetBranch === space.branch) throw new Error('Git basis');
    } catch { throw new ConflictException('업무·대상 HEAD 또는 실제 Git 경계가 변경되었습니다. 다시 확인해 주세요.'); }
    const release = projectCoordinator(this.store).acquireOperation({ kind: 'management', root: executionPath, commonDir, spaces: [executionPath], refs: [`refs/heads/${request.targetBranch}`, `refs/heads/${space.branch}`] });
    try { return this.settings.withSelectedRoot(selected => {
      assertPreparationCapacity(selected, selected.policy);
      const root = selected.roots.find(root => root.rootId === selected.selectedRootId);
      if (!root || !selected.managedPath) throw new ConflictException('확인된 작업 공간 루트를 먼저 설정해 주세요.');
      const candidateId = randomUUID(), candidatePath = join(root.managedPath, 'projects', space.projectId, 'integrations', candidateId, 'project');
      inspectWorkspacePath(candidatePath, [...this.settings.protectedPaths(), work.projectPath]);
      preflightGitDirectoryPath(candidatePath);
      // Git and SQLite are separate systems. Persist the observed HEADs; creation rechecks them.
      try { return this.store.transaction(() => {
        const existing = this.replay(work.id, request); if (existing) return existing;
        if (JSON.stringify(this.store.get(work.id)) !== JSON.stringify(work)) throw new ConflictException('업무 상태가 변경되었습니다. 다시 확인해 주세요.');
        assertCandidateCapacity(commonDir, this.store.integrationRequests());
        const now = new Date().toISOString(), id = `integration:${digest([work.id, request.requestKey])}`;
        const record: IntegrationRequest = { id, version: 1, workId: work.id, requestKey: request.requestKey, fingerprint: digest([work.id, request]), projectPath: resolve(work.projectPath), workspaceId: space.workspaceId, workExecutionPath: executionPath, commonDir, targetBranch: request.targetBranch, targetHead: request.expectedTargetHead, workHead: request.expectedWorkHead, reviewedVersion: request.reviewedVersion, sourceRevision: readiness.sourceRevision, workVerificationRefs: readiness.workVerificationRefs, candidateId, executionPath: candidatePath, profileId: selected.profileId, rootId: root.rootId, rootPath: root.path, managedPath: root.managedPath, projectId: space.projectId, candidateCommit: null, conflicts: [], verificationRefs: [], status: 'queued', createdAt: now, updatedAt: now };
        admission?.admit(); this.store.record(id, work.id, 'integration-request', record); return record;
      }); } catch (error: any) {
        if ([5, 6].includes(error?.errcode)) throw new ConflictException('다른 프로세스가 업무 상태를 저장 중입니다. 같은 요청 키로 다시 조회해 주세요.');
        throw error;
      }
    }); } finally { release(); }
  }
}
