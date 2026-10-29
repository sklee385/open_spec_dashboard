import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LegacyService } from '../legacy/legacy.service';
import { ConflictException, Optional } from '@nestjs/common';
import { WorkStore, type IntegrationRequest } from '../work/store';
import { WorkspaceService } from '../work/workspace.service';
import { assertCandidateProgress, verifyCandidateRegistration } from '../work/integration-candidate';
import { WorkspaceSettingsService } from '../work/workspace-settings.service';
import { createHash } from 'node:crypto';
export interface ResolvedProject { sourceId: string; root: string; gitRoot: string | null; commonDir: string | null; gitAvailable: boolean; boundary: boolean; candidate?: IntegrationRequest; }
@Injectable()
export class ProjectResolver {
  constructor(@Inject(LegacyService) private readonly legacy: LegacyService, @Optional() @Inject(WorkStore) private readonly store?: WorkStore) {}
  resolve(sourceId: string, workId?: string, candidateId?: string): ResolvedProject {
    if (candidateId !== undefined && (typeof candidateId !== 'string' || !candidateId || typeof workId !== 'string' || !workId)) throw new NotFoundException('후보에 연결된 업무를 지정해 주세요');
    if (typeof sourceId !== 'string' || !sourceId) throw new NotFoundException('Project not found');
    const source = this.legacy.sources().find(s => s.id === sourceId && s.valid);
    if (!source) throw new NotFoundException('Project not found');
    let root: string;
    try { const spec = realpathSync(source.path); if (!statSync(spec).isDirectory()) throw new Error(); root = realpathSync(dirname(spec)); }
    catch { throw new NotFoundException('Project directory not found'); }
    let candidate: IntegrationRequest | undefined;
    if (workId !== undefined) {
      if (typeof workId !== 'string' || !workId || !this.store) throw new NotFoundException('업무 공간을 찾을 수 없습니다');
      const work = this.store.get(workId);
      if (!work || work.sourceId !== sourceId) throw new NotFoundException('이 프로젝트에 연결된 업무 공간이 없습니다');
      if (['completed', 'archived'].includes(work.phase)) throw new ConflictException('진행 중인 업무 공간을 선택해 주세요');
      if (!samePath(realpathSync(work.projectPath), root)) throw new ConflictException('업무의 원본 프로젝트 경로가 변경되었습니다');
      root = new WorkspaceService(this.store).path(work);
      if (candidateId !== undefined) {
        const request = this.store.integrationRequests().find(row => row.workId === work.id && row.candidateId === candidateId);
        if (!request) throw new NotFoundException('이 업무에 연결된 후보가 없습니다');
        try {
          const active = this.store.integrationRequests().filter(row => row.workId === work.id && !['cancelled', 'removed', 'applied'].includes(row.status));
          const projectId = createHash('sha256').update(realpathSync(work.projectPath)).digest('hex');
          if (!['conflicted', 'validating', 'ready'].includes(request.status) || active.length !== 1 || active[0].id !== request.id || work.workspace?.kind !== 'git-worktree' || request.workspaceId !== work.workspace.workspaceId || request.projectId !== work.workspace.projectId || request.projectId !== projectId || !samePath(realpathSync(request.projectPath), realpathSync(work.projectPath)) || !samePath(request.workExecutionPath, root) || !work.workspace.commonDir || !samePath(realpathSync(request.commonDir), realpathSync(work.workspace.commonDir))) throw new Error('candidate relationship');
          const registration = verifyCandidateRegistration(request, new WorkspaceSettingsService(this.legacy).protectedPaths());
          if (request.status === 'conflicted') {
            if (registration.head !== request.targetHead || !request.resultCommit) throw new Error('candidate conflict basis');
            assertCandidateProgress(registration.path, request.resultCommit);
          } else { if (!request.candidateCommit || registration.head !== request.candidateCommit) throw new Error('candidate head'); assertCandidateProgress(registration.path); }
          candidate = request; root = registration.path;
        } catch { throw new ConflictException('후보의 상태·소유·HEAD 또는 병합 기준이 달라 다시 확인해야 합니다'); }
      }
    }
    const git = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), windowsHide: true, shell: false, timeout: 5000, maxBuffer: 65536 });
    const available = git(['--version']);
    const top = git(['rev-parse', '--show-toplevel']);
    let gitRoot: string | null = null, commonDir: string | null = null;
    if (top.status === 0) {
      try {
        gitRoot = realpathSync(top.stdout.replace(/\r?\n$/, ''));
        const common = git(['rev-parse', '--git-common-dir']);
        if (common.status === 0) commonDir = realpathSync(resolve(root, common.stdout.replace(/\r?\n$/, '')));
      } catch { gitRoot = null; commonDir = null; }
    }
    return { sourceId, root, gitRoot, commonDir, gitAvailable: !available.error && available.status === 0, boundary: gitRoot !== null && samePath(root, gitRoot), ...(candidate ? { candidate } : {}) };
  }
}
function samePath(a: string, b: string) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
