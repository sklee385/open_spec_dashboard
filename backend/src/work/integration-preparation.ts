import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runGit, GitError } from '../projects/git-runner';
import { projectCoordinator } from '../projects/coordinator';
import type { OperationRequest } from '../projects/operation-locks';
import type { WorkStore, IntegrationRequest, Work } from './store';
import type { WorkService } from './work.service';
import type { WorkspaceSettingsService } from './workspace-settings.service';
import type { DesktopLifecycle } from '../desktop/lifecycle';
import { candidateIdentity, candidateLocation, verifyCandidateRegistration, candidateBranch, assertCandidateProgress, candidateAutoMerge, assertCandidateAutoMerge } from './integration-candidate';
import { workspaceResourcePath } from './workspace-file-policy';
import { collectFiles, excludedNames } from './file-results';
import { collectWorkspaceDocuments } from './workspace-documents';
import { RequestBasisProof } from './request-basis-proof';
import { MutationAdmission } from './mutation-admission';
import { inspectWorkspacePath } from './workspace-paths';
import { preflightGitDirectoryPath } from './git-path-preflight';
import { assertPreparationCapacity, assertCandidateCapacity } from './workspace-policy';

type PrepareInput = { requestKey: string; confirmed: true; expectedVersion: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const oid = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const excluded = (work: Work, path: string) => workspaceResourcePath(work, path) || path.split('/').some(part => excludedNames.includes(part.toLowerCase())) || path.endsWith('.tsbuildinfo');
export type EditingBasisProof = { validation: RequestBasisProof<{ work: Work; context: string }>; request: IntegrationRequest; checkSync?: () => void };
/** Owns candidate mutations only. Work/source refs, indexes and execution identity are never borrowed. */
export class IntegrationPreparation {
  private active = new Map<string, { fingerprint: string; promise: Promise<any> }>();
  constructor(private store: WorkStore, private works: WorkService, private settings: WorkspaceSettingsService, private lifecycle: DesktopLifecycle) {}
  private run(root: string, args: string[], optional = false) { return runGit(root, ['-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', ...args], {}, optional); }
  private async text(root: string, args: string[], optional = false) { return (await this.run(root, args, optional)).toString('utf8').trim(); }
  private request(workId: string, candidateId: string) {
    this.works.get(workId);
    const request = this.store.integrationRequests().find(row => row.workId === workId && row.candidateId === candidateId);
    if (!request || ['cancelled', 'removed', 'applied'].includes(request.status)) throw new ConflictException('이 업무에 연결된 활성 후보를 확인해 주세요.');
    return request;
  }
  private parse(body: any): PrepareInput {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['requestKey', 'confirmed', 'expectedVersion'].includes(key)) || !/^[a-zA-Z0-9:_-]{1,160}$/.test(body.requestKey) || body.confirmed !== true || typeof body.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedVersion)) throw new BadRequestException('후보 요청 키·명시 확인·미리보기 버전을 확인해 주세요.');
    return { requestKey: body.requestKey, confirmed: true, expectedVersion: body.expectedVersion };
  }
  private capacity(request: IntegrationRequest) {
    const ancestor = inspectWorkspacePath(request.executionPath, this.settings.protectedPaths()).ancestor;
    let freeBytes: number | null = null;
    try { const fs = statfsSync(ancestor, { bigint: true }), free = fs.bavail * fs.bsize; if (free >= 0n && free <= BigInt(Number.MAX_SAFE_INTEGER)) freeBytes = Number(free); } catch {}
    assertPreparationCapacity({ available: true, confirmed: true, freeBytes }, this.settings.view().policy);
  }
  private async safeGit(request: IntegrationRequest) {
    // Definitions alone (including Windows Git's system LFS defaults) do not run programs.
    // Git resolves named user merge drivers before builtins; set/unset attributes bypass that lookup.
    const configuredKeys = (await this.run(request.workExecutionPath, ['config', '--null', '--name-only', '--get-regexp', '^merge[.].*[.](driver|recursive|name)$'], true)).toString().split('\0').filter(Boolean);
    const configuredDrivers = new Set(configuredKeys.map(key => key.slice(6, key.lastIndexOf('.'))));
    const defaultValue = (await this.run(request.workExecutionPath, ['config', '--null', '--get', 'merge.default'], true)).toString();
    const defaultDriver = defaultValue.endsWith('\0') ? defaultValue.slice(0, -1) : defaultValue;
    const assertMerge = (value: string) => {
      // check-attr prints reserved values as strings, so a same-named custom definition is ambiguous.
      if (configuredDrivers.has(value)) throw new ConflictException('후보 소스에 적용되는 외부 merge driver는 지원하지 않습니다.');
      if (value === 'set' || value === 'unset') return;
      const selected = value === 'unspecified' ? defaultDriver : value;
      if (value === 'unspecified' && !selected) return; // Git directly selects its builtin text driver.
      if (configuredDrivers.has(selected)) throw new ConflictException('후보 소스에 적용되는 외부 merge driver는 지원하지 않습니다.');
      // With no user definition, named builtins apply; unknown names fall back to builtin text in Git.
    };
    for (const commit of [request.targetHead, request.resultCommit]) {
      if (!oid(commit)) throw new ConflictException('검증한 결과 커밋이 없습니다.');
      const paths = (await this.run(request.workExecutionPath, ['ls-tree', '-r', '--name-only', '-z', commit])).toString().split('\0').filter(Boolean);
      for (let n = 0; n < paths.length;) {
        const batch: string[] = []; let length = 0;
        while (n < paths.length && batch.length < 100 && length + paths[n].length < 16000) { length += paths[n].length + 3; batch.push(paths[n++]); }
        if (!batch.length) throw new ConflictException('후보 속성 경로 한도를 초과했습니다.');
        const values = (await this.run(request.workExecutionPath, ['check-attr', `--source=${commit}`, '-z', 'filter', 'working-tree-encoding', 'ident', 'merge', '--', ...batch])).toString().split('\0');
        for (let at = 0; at + 2 < values.length; at += 3) {
          if (values[at + 1] === 'merge') assertMerge(values[at + 2]);
          else if (!['unspecified', 'unset'].includes(values[at + 2])) throw new ConflictException('후보 소스의 filter·인코딩·ident 변환은 지원하지 않습니다.');
        }
      }
    }
  }
  private async refs(request: IntegrationRequest, validatedRoot?: string) {
    const work = this.works.get(request.workId), path = validatedRoot ?? this.works.execution.executionPath(work);
    if (path !== request.workExecutionPath || work.projectPath !== request.projectPath || work.workspace?.workspaceId !== request.workspaceId || work.workspace.projectId !== request.projectId || realpathSync(await this.text(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== realpathSync(request.commonDir) || await this.text(path, ['symbolic-ref', 'HEAD']) !== `refs/heads/${work.workspace?.branch}` || await this.text(path, ['rev-parse', 'HEAD']) !== request.resultCommit || await this.text(path, ['rev-parse', 'HEAD^{tree}']) !== request.resultTree || await this.text(path, ['rev-parse', `refs/heads/${request.targetBranch}^{commit}`]) !== request.targetHead) throw new ConflictException('업무 결과·대상 tip 또는 실제 업무 소유가 변경되었습니다.');
  }
  private async basis(request: IntegrationRequest, validatedRoot?: string) {
    candidateLocation(request, this.settings.protectedPaths());
    await this.safeGit(request); await this.refs(request, validatedRoot);
    const ready = await this.works.integrationReadiness(request.workId, request.reviewedVersion, validatedRoot), work = ready.work;
    if (ready.sourceRevision !== request.sourceRevision) throw new ConflictException('결과 커밋 밖의 업무 소스가 변경되었습니다. 다시 검토·검증해 주세요.');
    const result = this.store.records(work.id, 'integration-result-commit').find(row => row.integrationId === request.id && ['committed', 'noop'].includes(row.status) && row.commit === request.resultCommit && row.tree === request.resultTree);
    if (!result || result.sourceRevision !== request.sourceRevision || result.ref !== `refs/heads/${work.workspace!.branch}` || hash(result.verificationRefs) !== hash(ready.workVerificationRefs) || this.store.records(work.id, 'workspace-git-intent').find(row => row.id === result.intentId)?.status !== 'passed') throw new ConflictException('검증된 결과 커밋과 필수 검증 근거가 일치하지 않습니다.');
    if (result.status === 'committed' && (result.commitObject !== request.resultCommit || result.expectedTree !== request.resultTree || await this.text(request.workExecutionPath, ['show', '-s', '--format=%P', request.resultCommit!]) !== request.workHead || await this.text(request.workExecutionPath, ['show', '-s', '--format=%B', request.resultCommit!]) !== result.message.trim()) || result.status === 'noop' && (request.resultCommit !== request.workHead || result.startHead !== request.workHead)) throw new ConflictException('결과 커밋의 실제 OID·부모·tree 근거가 다릅니다.');
    const staged = await this.run(request.workExecutionPath, ['diff', '--cached', '--name-only', '-z', '--']);
    const flags = (await this.run(request.workExecutionPath, ['ls-files', '-v', '-z'])).toString().split('\0').filter(Boolean);
    const dirty = (await this.run(request.workExecutionPath, ['status', '--porcelain=v1', '--no-renames', '-z', '--untracked-files=all'])).toString().split('\0').filter(Boolean);
    if (staged.length || flags.some(entry => !excluded(work, entry.slice(2)) && (entry[0] === 'S' || /[a-z]/.test(entry[0]))) || dirty.some(entry => !excluded(work, entry.slice(3)))) throw new ConflictException('업무 index 또는 결과 커밋 밖 제품 소스 변경을 먼저 확인해 주세요.');
    await this.refs(request, validatedRoot);
    return { work, context: hash([work, ready.sourceRevision, ready.workVerificationRefs, result, this.works.execution.snapshot(work, validatedRoot)]) };
  }
  /** Every read is fresh. The supplied root was authorized by this checkpoint's owner check. */
  private async editingStamp(request: IntegrationRequest, validatedRoot: string, capture?: (check: () => void) => void) {
    const work = this.works.get(request.workId);
    if (validatedRoot !== request.workExecutionPath || work.executionPath !== validatedRoot) throw new ConflictException('업무 실행 소유가 변경되었습니다');
    const fsStamp = () => {
      const latest = this.works.get(work.id);
      if (hash(latest) !== hash(work) || hash(this.store.integrationRequests().find(row => row.id === request.id)) !== hash(request)) throw new ConflictException('후보·업무 기록이 변경되었습니다');
      const source = collectFiles(validatedRoot, path => excluded(work, path), true);
      const ownerFiles = [join(request.managedPath, 'identity.json'), join(dirname(validatedRoot), 'identity.json'), join(validatedRoot, '.git'), join(dirname(request.executionPath), 'identity.json'), join(request.executionPath, '.git')];
      for (const path of [validatedRoot, request.executionPath]) {
        const pointer = readFileSync(join(path, '.git'), 'utf8').trim();
        if (!pointer.startsWith('gitdir: ')) throw new ConflictException('후보 편집 Git 포인터가 변경되었습니다');
        const gitDir = resolve(path, pointer.slice(8)); ownerFiles.push(join(gitDir, 'gitdir'), join(gitDir, 'commondir'));
      }
      const owners = ownerFiles.map(path => {
        inspectWorkspacePath(dirname(path), []); const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new ConflictException('후보 편집 소유 파일이 변경되었습니다');
        return [path, stat.dev, stat.ino, stat.mode, readFileSync(path, 'utf8')];
      });
      const pointer = readFileSync(join(validatedRoot, '.git'), 'utf8').trim();
      if (!pointer.startsWith('gitdir: ')) throw new ConflictException('업무 Git 포인터가 변경되었습니다');
      const gitDir = resolve(validatedRoot, pointer.slice(8)); inspectWorkspacePath(gitDir, []);
      const sourcePointer = join(request.projectPath, '.git'), sourceGitDir = lstatSync(sourcePointer).isDirectory() ? sourcePointer : resolve(request.projectPath, readFileSync(sourcePointer, 'utf8').trim().slice(8));
      const readRef = (path: string) => {
        inspectWorkspacePath(dirname(path), []); if (!existsSync(path)) return null;
        const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new ConflictException('업무 ref의 소유가 변경되었습니다');
        return readFileSync(path, 'utf8');
      };
      const sourceHead = readRef(join(sourceGitDir, 'HEAD')), workHead = readRef(join(gitDir, 'HEAD'));
      const refNames = [`refs/heads/${request.targetBranch}`, `refs/heads/${work.workspace!.branch}`];
      for (const head of [sourceHead, workHead]) if (head?.startsWith('ref: ')) {
        const ref = head.slice(5).trim(); if (!ref.startsWith('refs/') || /[\\\0]/.test(ref) || ref.split('/').some(part => !part || ['.', '..'].includes(part))) throw new ConflictException('업무 HEAD 포인터가 변경되었습니다');
        refNames.push(ref);
      }
      const refs = [...new Set(refNames)].sort().map(ref => [ref, readRef(join(request.commonDir, ref))]);
      const packed = (readRef(join(request.commonDir, 'packed-refs')) ?? '').split('\n').filter(line => refNames.includes(line.trim().split(' ')[1]));
      const progress = ['HEAD', 'index', 'commondir', 'gitdir', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'sequencer', 'rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'MERGE_AUTOSTASH', 'AUTO_MERGE'].map(name => {
        const path = join(gitDir, name); if (!existsSync(path)) return [name, null];
        const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new ConflictException('업무 Git 진행 소유가 변경되었습니다');
        return [name, stat.dev, stat.ino, stat.mode, stat.isFile() ? hash(readFileSync(path).toString('base64')) : stat.mtimeMs];
      });
      // Candidate mutation fields are checked against proof.request separately. Only reserve
      // may replace that exact expected request after its transactional CAS succeeds.
      const candidates = this.store.integrationRequests().filter(row => row.workId === work.id).map(row => {
        if (row.id !== request.id) return row;
        const { status, candidateMutationVersion, verificationRefs, updatedAt, ...stable } = row;
        return stable;
      });
      return hash([work, candidates, ['integration-result-commit', 'verification', 'browser-verification', 'question', 'integration-preparation', 'workspace-preparation', 'workspace-local-policy', 'workspace-local-preparation'].map(kind => this.store.records(work.id, kind)),
        this.store.records(work.id, 'workspace-git-intent').filter(row => this.store.records(work.id, 'integration-result-commit').some(result => result.intentId === row.id)),
        source, Object.keys(source).map(path => [path, lstatSync(join(validatedRoot, path)).mode & 0o777]), collectWorkspaceDocuments(request.projectPath, work.changeName), collectWorkspaceDocuments(validatedRoot, work.changeName),
        this.works.execution.commands(work, 'full', undefined, validatedRoot), owners, progress, sourceHead, workHead, refs, packed]);
    };
    const before = fsStamp();
    const git = await Promise.all([
      this.run(request.projectPath, ['rev-parse', 'HEAD']), this.run(request.projectPath, ['ls-files', '--stage', '-z']),
      this.run(validatedRoot, ['rev-parse', 'HEAD', 'HEAD^{tree}', `refs/heads/${request.targetBranch}^{commit}`]),
      this.run(validatedRoot, ['ls-files', '--stage', '-v', '-z']), this.run(validatedRoot, ['config', '--null', '--list', '--show-origin']),
      this.run(request.projectPath, ['worktree', 'list', '--porcelain', '-z']),
    ]);
    if (fsStamp() !== before) throw new ConflictException('후보 편집 근거를 읽는 중 변경되었습니다');
    capture?.(() => { if (fsStamp() !== before) throw new ConflictException('후보 최종 확인 중 업무·계획·검증 근거가 변경되었습니다'); });
    // Candidate HEAD changes only through this operation's CAS and is checked separately
    // by state/observeCommit; registration, branch, lock and pruning flags remain fixed.
    const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    const roots = [request.projectPath, validatedRoot, request.executionPath].map(key), refs = [`refs/heads/${request.targetBranch}`, `refs/heads/${work.workspace!.branch}`, `refs/heads/${candidateBranch(request)}`];
    const listing = git.pop()!.toString().split('\0\0').map(group => group.split('\0').filter(Boolean)).filter(fields => fields.some(field => field.startsWith('worktree ') && roots.includes(key(field.slice(9))) || field.startsWith('branch ') && refs.includes(field.slice(7)))).map(fields => fields.some(field => field.startsWith('worktree ') && key(field.slice(9)) === key(request.executionPath)) ? fields.filter(field => !field.startsWith('HEAD ')) : fields);
    return hash([before, git.map(value => value.toString()), listing]);
  }
  /** First full gate remains intact; only this HTTP request may reuse its unchanged proof. */
  async editingBasis(request: IntegrationRequest, proof?: EditingBasisProof, validatedRoot?: string) {
    const root = validatedRoot ?? this.works.execution.executionPath(this.works.get(request.workId));
    if (proof && hash(proof.request) !== hash(request)) throw new ConflictException('후보 편집 요청이 변경되었습니다');
    let checkSync: (() => void) | undefined;
    const read = () => this.editingStamp(request, root, check => { checkSync = check; if (proof) proof.checkSync = check; });
    if (!proof) {
      const validation = await RequestBasisProof.create(() => this.basis(request, root), read);
      return { ...validation.basis, proof: { validation, request, checkSync } };
    }
    const basis = await proof.validation.check(read, proof.validation.basis.work.browserScenario ? () => this.works.browser.assertPassed(this.works.get(request.workId)) : undefined);
    return { ...basis, proof };
  }
  private version(request: IntegrationRequest, context: string) { return hash([request.id, request.fingerprint, request.candidateId, request.executionPath, request.targetHead, request.resultCommit, request.resultTree, context]); }
  async preview(workId: string, candidateId: string) {
    const request = this.request(workId, candidateId);
    if (request.status !== 'queued') throw new ConflictException('예약된 후보만 새 준비를 미리 볼 수 있습니다.');
    const basis = await this.basis(request);
    return { candidateId, candidateVersion: this.version(request, basis.context), targetHead: request.targetHead, resultCommit: request.resultCommit, executionPath: request.executionPath, branch: candidateBranch(request) };
  }
  private save(row: any) { this.store.record(row.id, row.workId, 'integration-preparation', row); }
  private publish(request: IntegrationRequest, row: any, status: 'validating' | 'conflicted') {
    const current = this.request(request.workId, request.candidateId);
    const next = { ...current, status, candidateCommit: status === 'validating' ? row.commit : null, conflicts: row.conflicts ?? [], verificationRefs: [], updatedAt: new Date().toISOString(), error: undefined };
    this.store.transaction(() => { this.store.record(request.id, request.workId, 'integration-request', next); row.status = status; this.save(row); this.clearIntents(row); });
    return next;
  }
  private async conflict(request: IntegrationRequest, row: any) {
    const registration = verifyCandidateRegistration(request, this.settings.protectedPaths());
    assertCandidateProgress(request.executionPath, request.resultCommit!);
    assertCandidateAutoMerge(request.executionPath, row);
    const mergeHead = await this.text(request.executionPath, ['rev-parse', '--verify', 'MERGE_HEAD'], true), entries = (await this.run(request.executionPath, ['ls-files', '--unmerged', '-z'])).toString().split('\0').filter(Boolean);
    if (registration.head !== request.targetHead || mergeHead !== request.resultCommit || !entries.length || entries.some(entry => !/^[0-7]{6} [a-f0-9]+ [123]\t[^\0]+$/.test(entry))) throw new ConflictException('후보 소유의 병합 충돌 근거를 확인할 수 없습니다.');
    return [...new Set(entries.map(entry => entry.slice(entry.indexOf('\t') + 1)))].sort();
  }
  private async completed(request: IntegrationRequest, row: any) {
    if (row.processTerminated !== true) throw new ConflictException('소유 Git 프로세스의 종료를 먼저 확인해 주세요.');
    const registration = verifyCandidateRegistration(request, this.settings.protectedPaths());
    assertCandidateProgress(request.executionPath);
    if (candidateAutoMerge(request.executionPath) !== null) throw new ConflictException('남아 있는 AUTO_MERGE는 정리하지 않고 보존합니다.');
    await this.refs(request);
    if (registration.head !== row.commit || await this.text(request.executionPath, ['rev-parse', 'HEAD^{tree}']) !== row.tree || (await this.run(request.executionPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length || await this.text(request.executionPath, ['rev-parse', '--verify', 'MERGE_HEAD'], true)) throw new ConflictException('후보 실제 commit·tree 또는 병합 완료 상태가 다릅니다.');
    if (row.noop) { if (row.commit !== request.targetHead || await this.text(request.executionPath, ['merge-base', request.resultCommit!, row.commit]) !== request.resultCommit) throw new ConflictException('대상에 이미 포함된 결과의 근거가 다릅니다.'); }
    else if (row.tree !== row.expectedTree || row.commit !== row.commitObject || await this.text(request.executionPath, ['show', '-s', '--format=%P', row.commit]) !== `${request.targetHead} ${request.resultCommit}` || await this.text(request.executionPath, ['show', '-s', '--format=%B', row.commit]) !== row.marker) throw new ConflictException('후보 marker·부모·OID가 다릅니다.');
  }
  private async replay(request: IntegrationRequest, row: any) {
    if (row.status === 'failed') return { ...request, status: 'failed', error: row.error };
    let terminated = row.processTerminated === true;
    if (!terminated) return { ...request, status: 'uncertain', error: '소유 Git Job의 실제 종료 근거가 없습니다. PID 부재로 복구하지 않습니다.' };
    try {
      if ((await this.basis(request)).context !== row.basisContext) throw new ConflictException('후보 준비 당시의 업무 소스·계획·검증이 변경되었습니다.');
      if (row.commit || row.commitObject) {
        const observed = { ...row, processTerminated: terminated, commit: row.commit ?? row.commitObject };
        await this.completed(request, observed);
        // A read cannot erase later verification refs or rewind ready back to validating.
        if (['validating', 'ready', 'applying'].includes(request.status)) return request;
        return this.publish(request, observed, 'validating');
      }
      if (row.conflicts?.length) {
        row.conflicts = await this.conflict(request, row); await this.refs(request);
        if (request.status === 'conflicted') return request;
        return this.publish(request, row, 'conflicted');
      }
    } catch { /* Unknown state never triggers add/merge/commit replay. */ }
    return { ...request, status: 'uncertain', error: '실제 후보 근거를 확인할 수 없습니다. 자동 재실행하지 않습니다.' };
  }
  private clearIntents(row: any) { for (const intent of this.store.records(row.workId, 'workspace-git-intent').filter(intent => row.intentIds?.includes(intent.id))) this.store.record(intent.id, row.workId, 'workspace-git-intent', { ...intent, status: 'passed', terminationUnconfirmed: false }); }
  prepare(workId: string, candidateId: string, body: unknown): Promise<any> {
    const input = this.parse(body), fingerprint = hash(input), key = `${workId}:${candidateId}`, active = this.active.get(key);
    if (active) { if (active.fingerprint !== fingerprint) throw new ConflictException('다른 후보 준비 요청이 실행 중입니다.'); return active.promise; }
    const exists = () => this.store.records(workId, 'integration-preparation').some(row => row.candidateId === candidateId);
    const promise = (exists() ? this.perform(workId, candidateId, input, fingerprint) : new MutationAdmission(this.store, workId, `candidate-prepare:${candidateId}`, input.requestKey, fingerprint, exists).run(admission => this.perform(workId, candidateId, input, fingerprint, admission))).finally(() => this.active.delete(key));
    this.active.set(key, { fingerprint, promise }); return promise;
  }
  private async perform(workId: string, candidateId: string, input: PrepareInput, fingerprint: string, admission?: MutationAdmission) {
    const request = this.request(workId, candidateId), previous = this.store.records(workId, 'integration-preparation').find(row => row.candidateId === candidateId);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new ConflictException('고정 후보에 다른 준비 요청을 사용할 수 없습니다.'); return this.replay(request, previous); }
    if (request.status !== 'queued') throw new ConflictException('예약한 후보만 새로 준비할 수 있습니다.');
    this.lifecycle.assertUnlocked(); const settle = this.lifecycle.beginRequest('integration-candidate', workId);
    let release: (() => void) | undefined, row: any, reserved = false;
    const plan: OperationRequest = { kind: 'management', root: request.workExecutionPath, commonDir: request.commonDir, spaces: [request.workExecutionPath, request.executionPath], refs: [`refs/heads/${request.targetBranch}`, `refs/heads/${this.works.get(workId).workspace?.branch}`, `refs/heads/${candidateBranch(request)}`] };
    try {
      release = projectCoordinator(this.store).acquireOperation(plan);
      const basis = await this.basis(request);
      if (input.expectedVersion !== this.version(request, basis.context)) throw new ConflictException('후보 미리보기 기준이 변경되었습니다.');
      assertCandidateCapacity(request.commonDir, this.store.integrationRequests(), request.id);
      this.capacity(request);
      const location = candidateLocation(request, this.settings.protectedPaths()); preflightGitDirectoryPath(location.path);
      if (existsSync(location.container) || (await this.text(request.workExecutionPath, ['for-each-ref', '--format=%(refname)', `refs/heads/${location.branch}`])).length) throw new ConflictException('기존 후보 경로 또는 브랜치를 채택하지 않습니다.');
      const observed = async () => hash([await this.text(request.projectPath, ['rev-parse', 'HEAD']), (await this.run(request.projectPath, ['ls-files', '--stage', '-z'])).toString(), await this.text(request.workExecutionPath, ['rev-parse', 'HEAD']), (await this.run(request.workExecutionPath, ['ls-files', '--stage', '-z'])).toString()]);
      const before = await observed(), id = `${request.id}:candidate-prepare`;
      const reservationIntentId = `${id}:git:reservation`, lifetime: any = { scope: plan.kind, root: plan.root, commonDir: plan.commonDir, refs: plan.refs, affectedRoots: plan.spaces, status: 'running', stage: 'candidate-preparation' };
      row = { id, candidateId, workId, fingerprint, requestKey: input.requestKey, expectedVersion: input.expectedVersion, basisContext: basis.context, status: 'running', reservationIntentId, intentIds: [reservationIntentId] as string[], marker: `OpenSpecBoard integration ${request.id} candidate ${candidateId}`, createdAt: new Date().toISOString() };
      this.store.transaction(() => {
        if (this.store.records(workId, 'integration-preparation').some(row => row.candidateId === candidateId) || this.request(workId, candidateId).status !== 'queued') throw new ConflictException('다른 후보 준비가 이미 예약되었습니다.');
        projectCoordinator(this.store).assertRecovery(plan);
        admission?.admit();
        this.save(row); this.store.record(reservationIntentId, workId, 'workspace-git-intent', lifetime); this.store.record(request.id, workId, 'integration-request', { ...request, status: 'preparing', updatedAt: new Date().toISOString() });
      }); reserved = true;
      const mutate = async (stage: string, root: string, args: string[]) => {
        if (stage === 'merge-finish') { assertCandidateProgress(root, request.resultCommit!); assertCandidateAutoMerge(root, row); }
        const intentId = `${id}:git:${stage}`, intent: any = { scope: plan.kind, root: plan.root, commonDir: plan.commonDir, refs: plan.refs, affectedRoots: plan.spaces, status: 'running', stage };
        row.stage = stage; row.intentIds.push(intentId); row.processTerminated = false;
        this.store.transaction(() => { this.save(row); this.store.record(intentId, workId, 'workspace-git-intent', intent); });
        try {
          const output = await runGit(root, ['-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', `core.hooksPath=${join(location.container, 'disabled-hooks')}`, '-c', 'commit.gpgSign=false', '-c', 'user.name=OpenSpecBoard', '-c', 'user.email=integration@openspecboard.local', ...args], { timeoutMs: 10000, maxOutputBytes: 4 * 1024 * 1024, ownedJob: true, onTermination: evidence => { row.processTerminated = true; row.terminationProof = evidence; this.save(row); }, onSpawn: pid => { row.processId = intent.processId = lifetime.processId = pid; this.store.transaction(() => { this.save(row); this.store.record(intentId, workId, 'workspace-git-intent', intent); this.store.record(reservationIntentId, workId, 'workspace-git-intent', lifetime); }); } });
          row.processTerminated = true;
          if (stage === 'merge') { row.autoMerge = candidateAutoMerge(root); row.autoMergeCaptured = true; }
          if (stage === 'merge-finish') row.mergeFinished = true;
          this.store.record(intentId, workId, 'workspace-git-intent', { ...intent, status: 'passed' }); this.save(row); return output;
        } catch (error: any) {
          if (stage === 'merge' && error instanceof GitError && !error.uncertain) { row.autoMerge = candidateAutoMerge(root); row.autoMergeCaptured = true; }
          row.processTerminated = row.processTerminated === true || error instanceof GitError && !error.terminationUnconfirmed;
          this.store.record(intentId, workId, 'workspace-git-intent', { ...intent, status: error instanceof GitError && !error.uncertain ? 'failed' : 'uncertain', terminationUnconfirmed: row.processTerminated === false }); throw error;
        }
      };
      mkdirSync(join(location.container, '..'), { recursive: true }); candidateLocation(request, this.settings.protectedPaths()); mkdirSync(location.container);
      writeFileSync(join(location.container, 'identity.json'), JSON.stringify(candidateIdentity(request)), { flag: 'wx' }); mkdirSync(join(location.container, 'disabled-hooks'));
      await this.refs(request); await this.safeGit(request);
      await mutate('create', request.workExecutionPath, ['worktree', 'add', '--no-checkout', '-b', location.branch, '--', location.path, request.targetHead]);
      if (verifyCandidateRegistration(request, this.settings.protectedPaths()).head !== request.targetHead) throw new ConflictException('생성한 후보 기준이 다릅니다.');
      await mutate('checkout', location.path, ['read-tree', '--reset', '-u', 'HEAD']);
      this.capacity(request); await this.refs(request); assertCandidateProgress(location.path);
      row.autoMergeCaptured = true; row.autoMerge = candidateAutoMerge(location.path); this.save(row);
      if (await this.text(location.path, ['merge-base', request.resultCommit!, request.targetHead]) === request.resultCommit) {
        row.noop = true; row.commit = request.targetHead; row.tree = await this.text(location.path, ['rev-parse', 'HEAD^{tree}']);
      } else {
        try { await mutate('merge', location.path, ['merge', '--no-autostash', '--no-ff', '--no-commit', '--no-edit', request.resultCommit!]); }
        catch (error) {
          if (!(error instanceof GitError) || error.uncertain) throw error;
          row.conflicts = await this.conflict(request, row); await this.refs(request);
          if (await observed() !== before || (await this.basis(request)).context !== basis.context) throw new ConflictException('후보 준비 중 원본·업무 ref/index 또는 검증 근거가 변경되었습니다.');
          this.capacity(request); return this.publish(request, row, 'conflicted');
        }
        // Prove the merge from immutable inputs; a mutable candidate index is not its own proof.
        row.expectedTree = (await mutate('merge-proof', location.path, ['merge-tree', '--write-tree', '--no-messages', request.targetHead, request.resultCommit!])).toString().trim();
        row.tree = await this.text(location.path, ['write-tree']);
        if (!oid(row.expectedTree) || row.tree !== row.expectedTree) throw new ConflictException('실제 index가 두 입력 커밋의 검증한 병합 tree와 다릅니다.');
        this.save(row);
        await this.refs(request);
        if ((await this.basis(request)).context !== basis.context) throw new ConflictException('병합 중 업무 검증 기준이 변경되었습니다.');
        row.commitObject = (await mutate('commit-object', location.path, ['commit-tree', row.tree, '-p', request.targetHead, '-p', request.resultCommit!, '-m', row.marker])).toString().trim(); this.save(row);
        await this.refs(request);
        await mutate('commit-ref', location.path, ['update-ref', '--no-deref', `refs/heads/${location.branch}`, row.commitObject, request.targetHead]); row.commit = row.commitObject; this.save(row);
        // Interrupted finalization keeps exact MERGE_HEAD/input/tree/commit evidence for explicit recovery.
        row.mergeHead = assertCandidateProgress(location.path, request.resultCommit!); this.save(row);
        await mutate('merge-finish', location.path, ['merge', '--quit']);
      }
      await this.completed(request, row);
      if (await observed() !== before || (await this.basis(request)).context !== basis.context) throw new ConflictException('후보 준비 중 원본·업무 ref/index 또는 검증 소스가 변경되었습니다.');
      this.capacity(request); return this.publish(request, row, 'validating');
    } catch (error: any) {
      if (!reserved) throw error;
      row.status = row.commit || row.commitObject || row.conflicts?.length || row.processTerminated === false || error instanceof GitError && error.uncertain ? 'uncertain' : 'failed'; row.error = error instanceof Error ? error.message : '후보 실제 상태 확인이 필요합니다.';
      this.store.transaction(() => {
        this.save(row);
        const held = this.store.records(workId, 'workspace-git-intent').find(intent => intent.id === row.reservationIntentId);
        if (held) this.store.record(held.id, workId, 'workspace-git-intent', { ...held, status: row.status, terminationUnconfirmed: row.processTerminated === false });
        const current = this.request(workId, candidateId); this.store.record(request.id, workId, 'integration-request', { ...current, status: row.status, error: row.error, updatedAt: new Date().toISOString() });
      });
      return { ...this.request(workId, candidateId), error: row.error };
    } finally {
      if (row?.processTerminated !== false) { try { release?.(); } finally { settle(); } }
    }
  }
}
