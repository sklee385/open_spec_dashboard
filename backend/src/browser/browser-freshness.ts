import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ProjectResolver } from '../projects/resolver';
import { readGitSync } from '../projects/git-runner';
import { WorkStore, type Work } from '../work/store';
import { VerificationEnvironments } from './verification-environment';
import { VerificationSnapshots } from './verification-snapshot';
import { readBrowserBuildContract, validBrowserBuild } from './browser-build';

export const browserDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const policy = (work: Work) => [work.id, work.sourceId, work.projectPath, work.executionPath, work.workspace, work.browserScenario, work.verificationCommands, work.sourceMutationVersion, work.reviewedVersion, work.threadId, work.turnId];
export class BrowserFreshness {
  constructor(private store: WorkStore, private resolver: ProjectResolver) {}
  private target(workId: string, candidateId?: string) {
    const work = this.store.get(workId); if (!work) throw new ConflictException('브라우저 검증 업무가 없습니다');
    const request = candidateId ? this.store.integrationRequests().find(row => row.workId === workId && row.candidateId === candidateId) : undefined;
    if (candidateId && !request) throw new ConflictException('브라우저 검증 후보가 없습니다');
    const targetRef = request ? `refs/heads/${request.targetBranch}` : null;
    const targetHead = request ? readGitSync(request.projectPath, ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', `${targetRef}^{commit}`]).trim() : null;
    if (request && targetHead !== request.targetHead) throw new ConflictException('실제 원본 대상 ref가 변경되어 후보 재검증이 필요합니다');
    const candidate = request ? [request.id, request.fingerprint, request.candidateId, request.candidateMutationVersion ?? null, request.candidateCommit, request.targetBranch, request.targetHead, request.resultCommit, request.workspaceId, request.projectPath, request.workExecutionPath, request.executionPath, request.commonDir] : null;
    return { work, targetRef, targetHead, candidate, stamp: browserDigest([policy(work), candidate, targetRef, targetHead]) };
  }
  async capture(workId: string, candidateId?: string) {
    const before = this.target(workId, candidateId), owner = await new VerificationEnvironments(this.store, this.resolver).capture({ sourceId: before.work.sourceId, workId, ...(candidateId ? { candidateId } : {}) }), environment = owner.environment;
    const { contract, version: contractVersion } = await readBrowserBuildContract(environment.executionPath);
    const outputs = [...contract.artifacts, contract.identity].map(file => file.path);
    const metadata = contract.freshness ? `openspec/changes/${before.work.changeName}/tasks.md` : undefined;
    const source = await new VerificationSnapshots(this.store).semanticRevision(environment.executionPath, outputs, metadata);
    const space = before.work.workspace;
    const basis = {
      targetKind: environment.targetKind, sourceId: environment.sourceId, workId, workspaceId: environment.workspaceId, executionPath: environment.executionPath,
      ownership: [space?.kind ?? 'copy', space?.profileId ?? null, space?.rootId ?? null, space?.projectId ?? null, space?.commonDir ?? null, space?.branch ?? null],
      candidateId: candidateId ?? null, candidateEpoch: environment.candidateEpoch, candidateCommit: candidateId ? environment.commit : null,
      candidate: before.candidate, targetRef: before.targetRef, targetHead: before.targetHead,
      source, planRevision: environment.planRevision, configVersion: environment.configVersion, contractVersion,
      generated: [...contract.artifacts, contract.identity],
      threadId: before.work.threadId, turnId: before.work.turnId ?? null,
    };
    await owner.assertCurrent();
    const assertUnchanged = () => { if (this.target(workId, candidateId).stamp !== before.stamp) throw new ConflictException('브라우저 판정 뒤 대상·정책 또는 실제 target ref가 변경되었습니다'); };
    assertUnchanged();
    return { basis, version: browserDigest(basis), environment, contractVersion, assertUnchanged };
  }
}

/** Do not migrate a historical passed flag into a new proof by guessing. */
export function browserEvidenceValid(row: any) {
  const evidence = row?.freshnessEvidence, environment = row?.environment;
  if (!environment || !evidence?.basis || evidence.basis.workId !== row.workId || evidence.basis.sourceId !== environment.sourceId || evidence.basis.targetKind !== row.targetKind || (row.candidateId ? row.targetKind !== 'integration-candidate' : row.targetKind !== 'work') || (evidence.basis.candidateId ?? null) !== (row.candidateId ?? null) || evidence.basis.candidateEpoch !== environment.candidateEpoch || evidence.basis.executionPath !== environment.executionPath || evidence.basis.workspaceId !== environment.workspaceId || (row.candidateId && evidence.basis.candidateCommit !== environment.commit)) return false;
  return row?.status === 'passed' && row.processTerminated === true && row.cleanupStatus !== 'uncertain' && evidence?.version === 1 && evidence.runId === row.id && evidence.environmentId === row.environmentId && environment?.environmentId === row.environmentId && environment.workId === row.workId && (environment.candidateId ?? null) === (row.candidateId ?? null) && environment.targetKind === row.targetKind && evidence.rawSourceRevision === environment.sourceRevision && evidence.executedCommit === environment.commit && evidence.buildId === row.buildAttestation?.buildId && browserDigest(evidence.basis) === evidence.semanticVersion && evidence.basis.contractVersion === row.buildAttestation.contractVersion && evidence.basis.configVersion === environment.configVersion && browserDigest(evidence.basis.generated) === browserDigest([...row.buildAttestation.artifacts, row.buildAttestation.identity].map(({ path, urlPath }: any) => ({ path, urlPath }))) && validBrowserBuild(row.buildAttestation, environment);
}
