import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ProjectResolver } from '../projects/resolver';
import { readGitSync } from '../projects/git-runner';
import { WorkStore, type Work } from '../work/store';
import { collectWorkspaceDocuments } from '../work/workspace-documents';
import { inspectWorkspacePath } from '../work/workspace-paths';
import { parseScenario } from './browser-policy';
import { VerificationSnapshots } from './verification-snapshot';

type Binding = { sourceId: string; workId: string; candidateId?: string };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface VerificationEnvironment {
  version: 1; environmentId: string; targetKind: 'work' | 'integration-candidate';
  sourceId: string; workId: string; workspaceId: string | null; candidateId: string | null; candidateEpoch: string | null;
  workspaceKind: 'copy' | 'git-worktree'; executionPath: string; commit: string | null;
  sourceRevision: string; planRevision: string; sourceMutationVersion: unknown; configVersion: string; targetVersion: string;
  origin: string; dataPath: string; evidencePath: string;
  ownership: 'verified'; ownershipScope: 'registered-target-at-capture';
  build: { state: 'unprepared'; buildId: null }; readiness: 'blocked'; blockedReason: 'build-provenance-unprepared';
}

/** Host-selected target contract only. This does not authorize a server or prove a build.
 * BrowserService/runner integration and build provenance are subsequent steps.
 */
export class VerificationEnvironments {
  private snapshots: VerificationSnapshots;
  constructor(private store: WorkStore, private resolver: ProjectResolver) { this.snapshots = new VerificationSnapshots(store); }

  private binding(input: unknown): Binding {
    const value = input as any;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['sourceId', 'workId', 'candidateId'].includes(key)) || typeof value.sourceId !== 'string' || !value.sourceId || typeof value.workId !== 'string' || !value.workId || value.candidateId !== undefined && (typeof value.candidateId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.candidateId))) throw new BadRequestException('호스트가 고정한 검증 업무·후보 식별만 사용할 수 있습니다');
    return { sourceId: value.sourceId, workId: value.workId, ...(value.candidateId === undefined ? {} : { candidateId: value.candidateId }) };
  }
  private policy(work: Work) {
    return [work.id, work.sourceId, work.projectPath, work.changeName, work.phase, work.executionPath, work.workspace, work.sourceMutationVersion ?? null, work.reviewedVersion, work.reviewedPlanRevision ?? null, work.verificationCommands ?? null, work.browserScenario];
  }
  private target(binding: Binding) {
    const work = this.store.get(binding.workId);
    if (!work || work.sourceId !== binding.sourceId) throw new NotFoundException('등록된 프로젝트·업무 검증 대상이 없습니다');
    // Resolver checks the stored source, workspace identity, actual registration,
    // candidate ownership and HEAD each time. There is no original/other-work fallback.
    const selected = this.resolver.resolve(binding.sourceId, binding.workId, binding.candidateId);
    const candidate = selected.candidate;
    if (binding.candidateId && !candidate) throw new ConflictException('후보 소유 확인이 누락되었습니다');
    const workspaceKind = work.workspace?.kind ?? 'copy';
    if (workspaceKind === 'git-worktree' && !selected.boundary) throw new ConflictException('검증 Git 실행 경계가 다릅니다');
    const commit = selected.boundary ? readGitSync(selected.root, ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{commit}']).trim() : null;
    if (candidate && commit !== candidate.candidateCommit) throw new ConflictException('검증할 후보 커밋이 준비되지 않았거나 변경되었습니다');
    const candidateBasis = candidate ? [candidate.id, candidate.fingerprint, candidate.workId, candidate.workspaceId, candidate.candidateId, candidate.candidateMutationVersion ?? null, candidate.candidateCommit, candidate.targetBranch, candidate.targetHead, candidate.resultCommit, candidate.projectPath, candidate.workExecutionPath, candidate.executionPath, candidate.commonDir] : null;
    return { work, selected, workspaceKind, commit, version: digest([this.policy(work), candidateBasis, selected.root, selected.gitRoot, selected.commonDir, commit]) };
  }
  private storage(environmentId: string) {
    const roots = [...this.store.list().flatMap(work => [work.projectPath, work.executionPath, work.workspace?.executionPath]), ...this.store.integrationRequests().flatMap(candidate => [candidate.projectPath, candidate.workExecutionPath, candidate.executionPath])].filter((path): path is string => typeof path === 'string');
    // Use the same bidirectional physical overlap/reparse checks as workspace copies.
    const data = inspectWorkspacePath(resolve(process.env.DATA_DIR || '../.data'), roots).path;
    const container = join(data, 'verification-environments', environmentId);
    return { dataPath: inspectWorkspacePath(join(container, 'data'), roots).path, evidencePath: inspectWorkspacePath(join(container, 'evidence'), roots).path };
  }
  private async inspect(binding: Binding, environmentId: string): Promise<VerificationEnvironment> {
    const before = this.target(binding), scenario = parseScenario(before.work.browserScenario), storage = this.storage(environmentId);
    const sourceRevision = await this.snapshots.revision(before.selected.root), planRevision = collectWorkspaceDocuments(before.selected.root, before.work.changeName).planRevision;
    const after = this.target(binding);
    if (after.version !== before.version || digest(this.storage(environmentId)) !== digest(storage) || await this.snapshots.revision(after.selected.root) !== sourceRevision) throw new ConflictException('검증 환경을 읽는 동안 대상·소스·설정이 변경되었습니다');
    return {
      version: 1, environmentId, targetKind: binding.candidateId ? 'integration-candidate' : 'work', sourceId: binding.sourceId, workId: binding.workId,
      workspaceId: before.work.workspace?.workspaceId ?? null, workspaceKind: before.workspaceKind, candidateId: binding.candidateId ?? null,
      candidateEpoch: before.selected.candidate?.candidateMutationVersion ?? null, executionPath: before.selected.root, commit: before.commit,
      sourceRevision, planRevision, sourceMutationVersion: before.work.sourceMutationVersion ?? null,
      configVersion: digest([scenario, before.work.verificationCommands ?? null, before.work.workspace?.preparationPolicyVersion ?? null, before.work.workspace?.preparationPolicyDigest ?? null]), targetVersion: before.version,
      origin: scenario.server.url, ...storage, ownership: 'verified', ownershipScope: 'registered-target-at-capture',
      build: { state: 'unprepared', buildId: null }, readiness: 'blocked', blockedReason: 'build-provenance-unprepared',
    };
  }
  /** Internal host API. No HTTP/CLI selector is added in this step. */
  async capture(input: unknown) {
    const binding = this.binding(input), environmentId = randomUUID(), environment = await this.inspect(binding, environmentId), version = digest(environment);
    return { environment, assertCurrent: async () => {
      if (digest(environment) !== version || digest(await this.inspect(binding, environmentId)) !== version) throw new ConflictException('저장된 검증 환경의 대상·등록·세대·소스·계획 또는 설정이 변경되었습니다');
    } };
  }
}
