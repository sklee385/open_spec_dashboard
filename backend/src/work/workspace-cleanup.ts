import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, open, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { WorkStore, Work } from './store';
import type { WorkspaceSettingsService } from './workspace-settings.service';
import { WorkspaceService } from './workspace.service';
import { CompletedResults } from './completed-results';
import { verifyCandidateRegistration } from './integration-candidate';
import { inspectArchiveSource } from './archive-observation';
import { readGitSync, runGit, GitError } from '../projects/git-runner';
import { projectCoordinator } from '../projects/coordinator';
import { desktopHealth } from '../desktop/health';
import { unresolvedQuestion } from '../codex/questions';
import { inspectWorkspacePath } from './workspace-paths';
import { MutationAdmission } from './mutation-admission';
import type { DesktopLifecycle } from '../desktop/lifecycle';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type CleanupBlocker = { code: string; message: string };
/** Preview is read-only; removal requires its exact confirmation and a fresh ownership check. */
export class WorkspaceCleanup {
  private checks = new Map<string, { workId: string; candidateId: string | null; version: string; target: any; expiresAt: number }>();
  constructor(private store: WorkStore, private settings: WorkspaceSettingsService, private lifecycle?: DesktopLifecycle) {}
  async preview(workId: string, candidateId?: string, inspectOnly = false, held = false) {
    if (candidateId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(candidateId)) throw new BadRequestException('정확한 후보 ID가 필요합니다');
    const work = this.store.get(workId); if (!work) throw new NotFoundException('업무를 찾을 수 없습니다');
    const blockers: CleanupBlocker[] = [], block = (code: string, message: string) => { if (!blockers.some(row => row.code === code)) blockers.push({ code, message }); };
    const base = { workId, candidateId: candidateId ?? null, targetKind: candidateId ? 'integration-candidate' : 'work', keepBranch: true, sourcePreserved: true, retainedPreserved: true };
    if (!['completed', 'archived'].includes(work.phase)) block('completion-required', '결과 보존과 사용자 완료 확인을 먼저 진행해 주세요');
    if (!['idle', 'failed', 'interrupted'].includes(work.state) || desktopHealth(this.store).runtime(work) !== 'inactive') block('execution-active-or-unknown', '실행 또는 실제 종료 확인이 필요합니다');
    const pending = this.store.db.prepare("SELECT 1 FROM records WHERE work_id=? AND (kind='question' AND json_extract(data,'$.status') IN ('pending','sending','recovering','uncertain') OR kind IN ('verification','candidate-verification','browser-verification','workspace-local-process','workspace-git-intent','archive-attempt') AND json_extract(data,'$.status') IN ('running','preparing','uncertain') OR kind='browser-verification' AND json_extract(data,'$.cleanupStatus')='uncertain' OR kind='queued-message' AND json_extract(data,'$.status') IN ('queued','dispatching','uncertain') OR id='browser-global-slot' AND json_extract(data,'$.status')<>'settled' OR kind IN ('verification','candidate-verification','browser-verification','workspace-local-process','workspace-git-intent','archive-attempt','workspace-cleanup') AND (json_extract(data,'$.terminationUnconfirmed')=1 OR json_extract(data,'$.processTerminated')=0 AND (json_extract(data,'$.processId')>0 OR json_extract(data,'$.guardPid')>0))) LIMIT 1").get(workId);
    if (pending || this.store.records(workId, 'question').some(unresolvedQuestion)) block('pending-control-or-process', '질문·승인·대기 요청 또는 미확인 프로세스를 먼저 처리해 주세요');
    let retained: any; try { retained = new CompletedResults(this.store).header(workId); if (!retained) block('retention-required', '완료 결과의 장기 보존을 먼저 확인해 주세요'); } catch { block('retention-unavailable', '완료 보존 기록을 확인할 수 없습니다'); }
    if (blockers.length) return { ...base, canRemove: false, blockers, version: null, target: null, retained: retained?.retained ?? null };
    let target: any;
    try {
      const settings = this.settings.read(), space = work.workspace;
      if (!space || space.kind !== 'git-worktree') throw new Error('현재 관리 Git 공간의 정리만 지원합니다. 다른 종류는 보존합니다');
      if (space.profileId !== settings.profileId || !settings.roots.some(root => root.rootId === space.rootId && root.path === space.rootPath && root.managedPath === space.managedPath)) throw new Error('등록된 원래 루트·프로필이 다릅니다');
      const protectedPaths = this.settings.protectedPaths();
      if (candidateId) {
        const request = this.store.integrationRequests().find(row => row.workId === workId && row.candidateId === candidateId);
        if (!request || request.workspaceId !== space.workspaceId || request.projectPath !== work.projectPath || request.workExecutionPath !== space.executionPath || request.commonDir !== space.commonDir || request.profileId !== space.profileId || request.projectId !== space.projectId) throw new Error('후보와 업무의 저장 소유가 다릅니다');
        const own = verifyCandidateRegistration(request, protectedPaths);
        target = { path: own.path, container: own.container, branch: own.branch, commonDir: request.commonDir, rootId: request.rootId, head: own.head, request };
        if (request.status !== 'applied' || retained?.integration?.candidateId !== candidateId || retained.integration.appliedCommit !== request.appliedCommit) block('unapplied-candidate', '반영되지 않았거나 보존 근거가 다른 후보는 정리하지 않습니다');
      } else {
        const path = new WorkspaceService(this.store, { protectedPaths: () => protectedPaths }).path(work);
        target = { path, container: dirname(path), branch: space.branch!, commonDir: space.commonDir!, rootId: space.rootId, head: readGitSync(path, ['rev-parse', '--verify', 'HEAD^{commit}']).trim() };
      }
      const observed = inspectArchiveSource(target.path, { commonDir: target.commonDir, branch: target.branch, head: target.head });
      if (observed.observation.state !== 'clean') block('dirty-or-unknown', '공간의 미커밋·미추적·숨김 변경 또는 검사 불가 상태를 먼저 확인해 주세요');
      const source = inspectArchiveSource(work.projectPath, { commonDir: target.commonDir });
      if (!source.observation.head) block('source-unavailable', '원본 Git 기준을 확인할 수 없습니다');
      else try { readGitSync(work.projectPath, ['merge-base', '--is-ancestor', target.head, source.observation.head]); } catch { block('unapplied-commits', '원본에 반영되지 않은 커밋이 남아 있습니다'); }
      const ignored = readGitSync(target.path, ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0').filter(Boolean);
      const policy = this.store.records(workId, 'workspace-local-policy').at(-1), prepared = this.store.records(workId, 'workspace-local-preparation').at(-1);
      const permitted = policy?.confirmed === true && prepared?.status === 'ready' && prepared.policyDigest === policy.policyDigest && work.workspace?.preparationPolicyDigest === policy.policyDigest ? [...(policy.generatedPaths ?? []), ...(policy.paths ?? []).filter((path: string) => /^(node_modules|vendor|\.venv|venv|\.runtime|runtime|\.tools\/node-runtime)(\/|$)/.test(path))] : [];
      const unknownIgnored = ignored.filter(path => !permitted.some((root: string) => path === root || path.startsWith(root + '/')));
      if (unknownIgnored.length) block('unknown-ignored', '사용자가 검토한 disposable 목록 밖의 ignored 파일을 먼저 확인해 주세요');
      const plan = { kind: 'management' as const, root: work.projectPath, commonDir: target.commonDir, spaces: [target.path], refs: ['refs/heads/' + target.branch] };
      try { if (!held) projectCoordinator(this.store).assertOperationCanStart(plan); } catch { block('space-busy', '해당 공간·관리 범위가 사용 중이거나 복구가 필요합니다'); }
      const tree = await cleanupManifest(target.path), identity = await cleanupManifest(target.container, ['project']);
      target = { path: target.path, container: target.container, branch: target.branch, commonDir: target.commonDir, rootId: target.rootId, head: target.head, sourceHead: source.observation.head, ignored, unknownIgnored, disposablePaths: permitted, files: tree.count, bytes: tree.bytes, treeVersion: tree.version, identityVersion: identity.version, cleanVersion: observed.observation.version, captureId: retained?.retained.captureId };
      if (identity.names.some(name => name !== 'identity.json') || identity.directories.some(name => name !== '' && name !== 'disabled-hooks')) block('unknown-container-files', '컨테이너에 소유가 확인되지 않은 파일이 있어 보존합니다');
    } catch (error) { block('ownership-unavailable', error instanceof Error ? error.message : '공간의 실제 소유를 확인할 수 없습니다'); target = undefined; }
    const version = blockers.length ? null : hash([work, target, this.controlVersion(work)]);
    let token: string | undefined;
    if (version && !inspectOnly) {
      for (const [id, check] of this.checks) if (check.expiresAt < Date.now()) this.checks.delete(id);
      while (this.checks.size >= 256) this.checks.delete(this.checks.keys().next().value!);
      token = randomUUID(); this.checks.set(token, { workId, candidateId: candidateId ?? null, version, target, expiresAt: Date.now() + 300000 });
    }
    return { ...base, canRemove: !blockers.length, blockers, version, ...(token ? { token } : {}), target: target ?? null, retained: retained?.retained ?? null };
  }
  status(workId: string, candidateId?: string) {
    if (candidateId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(candidateId)) throw new BadRequestException('정확한 후보 ID가 필요합니다');
    if (!this.store.get(workId)) throw new NotFoundException('업무를 찾을 수 없습니다');
    const row = this.store.db.prepare("SELECT data FROM records WHERE work_id=? AND kind='workspace-cleanup' AND coalesce(json_extract(data,'$.candidateId'),'')=? ORDER BY rowid DESC LIMIT 1").get(workId, candidateId ?? '') as { data: string } | undefined;
    return { receipt: row ? JSON.parse(row.data) : null };
  }
  async remove(workId: string, input: unknown, candidateId?: string) {
    const body = input as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 4 || Object.keys(body).some(key => !['requestKey','token','expectedVersion','confirmed'].includes(key)) || body.confirmed !== true || ![body.requestKey,body.token].every(value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) || typeof body.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedVersion)) throw new BadRequestException('정확한 정리 요청 키·확인 토큰·기준 버전이 필요합니다');
    const id = 'workspace-cleanup:' + hash([workId, body.requestKey]), fingerprint = hash([candidateId ?? null, body]);
    const receipt = () => { const row = this.store.db.prepare("SELECT data FROM records WHERE id=? AND work_id=? AND kind='workspace-cleanup'").get(id,workId) as {data:string}|undefined; if (!row) return; const value=JSON.parse(row.data); if (value.fingerprint !== fingerprint) throw new ConflictException('같은 요청 키의 정리 대상·내용을 바꿀 수 없습니다'); return value; };
    const prior = receipt(); if (prior) return prior;
    return new MutationAdmission(this.store,workId,'workspace-cleanup',String(body.requestKey),fingerprint,()=>!!receipt()).run(async admission => {
      const check = this.checks.get(String(body.token));
      if (!check || check.workId !== workId || check.candidateId !== (candidateId ?? null) || check.version !== body.expectedVersion || check.expiresAt < Date.now()) throw new ConflictException('정리 미리보기를 다시 확인해 주세요');
      const work = this.store.get(workId); if (!work) throw new NotFoundException('업무를 찾을 수 없습니다');
      this.lifecycle?.assertUnlocked();
      const target = check.target, plan = { kind: 'management' as const, root: work.projectPath, commonDir: target.commonDir, spaces: [target.path], refs: ['refs/heads/' + target.branch] }, release = projectCoordinator(this.store).acquireOperation(plan);
      const settle = this.lifecycle?.beginRequest('workspace-cleanup',workId);
      const intentId=id+':intent', owner=randomUUID(), runGeneration=randomUUID(); let started=false, terminated=false;
      let result: any = { id,workId,candidateId:candidateId??null,targetKind:candidateId?'integration-candidate':'work',workspaceId:work.workspace?.workspaceId,requestKey:body.requestKey,fingerprint,target,keepBranch:true,status:'running',intentId,owner,runGeneration,processTerminated:false,createdAt:new Date().toISOString() };
      let intent: any = { id:intentId,scope:'management',root:work.projectPath,commonDir:target.commonDir,refs:plan.refs,affectedRoots:[target.path],stage:'workspace-remove',owner,runGeneration,status:'running',processTerminated:false };
      try {
        const fresh = await this.preview(workId,candidateId,true,true);
        if (!fresh.canRemove || fresh.version !== check.version) throw new ConflictException({message:'미리보기 이후 실행·파일·소유 또는 기준이 변경되었습니다',blockers:fresh.blockers});
        this.store.transaction(()=>{
          if (hash(this.store.get(workId)) !== hash(work) || hash([work,fresh.target,this.controlVersion(work)]) !== fresh.version) throw new ConflictException('정리 확인 중 업무 상태가 변경되었습니다');
          admission.admit();this.store.record(id,workId,'workspace-cleanup',result);this.store.record(intentId,workId,'workspace-git-intent',intent);started=true;
        });
        // Normal removal only. No force, prune, branch removal or recursive root deletion.
        await runGit(work.projectPath,['-c','core.fsmonitor=false','worktree','remove','--',target.path],{timeoutMs:30000,onSpawn:pid=>{intent={...intent,processId:pid};this.store.record(intentId,workId,'workspace-git-intent',intent);}});
        terminated=true;
        let present=true;try{await lstat(target.path);}catch(error:any){if(error.code==='ENOENT')present=false;else throw error;}
        const registrations=readGitSync(work.projectPath,['worktree','list','--porcelain','-z']).split('\0').filter(value=>value.startsWith('worktree ')).map(value=>value.slice(9));
        if(present||registrations.some(path=>path.replaceAll('\\','/').toLowerCase()===target.path.replaceAll('\\','/').toLowerCase()))throw new Error('Git 공간 제거 결과를 확인할 수 없습니다');
        if((await cleanupManifest(target.container,['project'])).version!==target.identityVersion)throw new Error('컨테이너 소유 또는 파일이 변경되어 보존했습니다');
        inspectWorkspacePath(target.container,this.settings.protectedPaths());
        const hooks=join(target.container,'disabled-hooks');let hookStat;try{hookStat=await lstat(hooks);}catch(error:any){if(error.code!=='ENOENT')throw error;}
        if(hookStat){if(!hookStat.isDirectory()||hookStat.isSymbolicLink()||(await readdir(hooks)).length)throw new Error('훅 차단 폴더의 소유 또는 빈 상태가 달라 보존했습니다');await rmdir(hooks);}
        await unlink(join(target.container,'identity.json'));await rmdir(target.container);
        result={...result,status:'removed',processTerminated:true,removedAt:new Date().toISOString()};
        this.store.transaction(()=>{
          const saved=this.store.get(workId);if(hash(saved)!==hash(work))throw new Error('정리 결과 저장 중 업무가 변경되었습니다');
          this.store.record(id,workId,'workspace-cleanup',result);this.store.record(intentId,workId,'workspace-git-intent',{...intent,status:'passed',processTerminated:true});
          if(!candidateId)this.store.save({...work,workspace:{...work.workspace!,status:'removed'}});
          this.store.event(workId,'workspace-removed',{candidateId:candidateId??null,requestKey:body.requestKey,keepBranch:true});
        });
        this.checks.delete(String(body.token));return result;
      }catch(error){
        if(!started)throw error;
        const knownFailure=error instanceof GitError&&!error.uncertain&&!error.terminationUnconfirmed;
        result={...result,status:knownFailure?'failed':'uncertain',processTerminated:terminated||knownFailure,error:error instanceof Error?error.message:String(error)};
        try{this.store.transaction(()=>{this.store.record(id,workId,'workspace-cleanup',result);this.store.record(intentId,workId,'workspace-git-intent',{...intent,status:knownFailure?'failed':'uncertain',processTerminated:result.processTerminated});});}catch{/* Durable running intent remains a recovery block. */}
        return result;
      }finally{release();settle?.();}
    });
  }
  private controlVersion(work: Work) {
    return this.store.db.prepare("SELECT id,kind,json_extract(data,'$.status') status,json_extract(data,'$.owner') owner,json_extract(data,'$.runGeneration') runGeneration,json_extract(data,'$.processTerminated') processTerminated,json_extract(data,'$.candidateMutationVersion') candidateMutationVersion FROM records WHERE work_id=? ORDER BY id").all(work.id);
  }
}
/** Bounded asynchronous raw scan; rejects shared files/links before content access. */
export async function cleanupManifest(root: string, excluded: string[] = []) {
  inspectWorkspacePath(root, []); const digest = createHash('sha256'), names: string[] = [], directories: string[] = []; let count = 0, bytes = 0;
  const visit = async (path: string) => {
    if (++count > 250000) throw new Error('정리 검사 파일 수 한도를 초과했습니다');
    const name = relative(root, path).split(sep).join('/'), before = await lstat(path);
    if (before.isSymbolicLink()) throw new Error('링크·공유 경로를 정리 대상으로 사용하지 않습니다');
    if (before.isDirectory()) {
      directories.push(name);
      const children = (await readdir(path)).sort(); digest.update(JSON.stringify([name, before.dev, before.ino, 'directory', path === root ? children.filter(child => !excluded.includes(child)) : children]));
      for (const child of children) { if (path === root && excluded.includes(child)) continue; await visit(join(path, child)); }
      const after = await lstat(path); if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('정리 검사 중 폴더가 변경되었습니다');
    } else {
      if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024**2 || (bytes += before.size) > 512 * 1024**2) throw new Error('정리 파일 소유 또는 읽기 한도를 확인해 주세요');
      const fd = await open(path, 'r'), content = createHash('sha256');
      try { const opened = await fd.stat(); if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || !opened.isFile()) throw new Error('정리 검사 파일이 교체되었습니다'); let size = 0; const buffer = Buffer.allocUnsafe(65536); while (true) { const part = await fd.read(buffer, 0, buffer.length, null); if (!part.bytesRead) break; size += part.bytesRead; if (size > before.size) throw new Error('정리 파일 크기가 변경되었습니다'); content.update(buffer.subarray(0, part.bytesRead)); } if (size !== before.size) throw new Error('정리 파일 크기가 변경되었습니다'); } finally { await fd.close(); }
      const after = await lstat(path); if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('정리 파일이 검사 중 변경되었습니다');
      names.push(name); digest.update(JSON.stringify([name, before.dev, before.ino, before.mode, before.mtimeMs, before.ctimeMs, content.digest('hex')]));
    }
  };
  await visit(root); return { version: digest.digest('hex'), count, bytes, names, directories };
}
