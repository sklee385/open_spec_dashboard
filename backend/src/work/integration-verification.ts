import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WorkStore, type IntegrationRequest, type Work } from './store';
import { WorkService } from './work.service';
import { ProjectResolver } from '../projects/resolver';
import { WorkspaceSettingsService } from './workspace-settings.service';
import { DesktopLifecycle } from '../desktop/lifecycle';
import { desktopHealth } from '../desktop/health';
import { projectCoordinator } from '../projects/coordinator';
import type { OperationRequest } from '../projects/operation-locks';
import { readGitSync, runGit } from '../projects/git-runner';
import { parseGitCachedSizes, readCleanTrackedFiles, readGitTextAttributes } from './git-clean-files';
import { candidateBranch, candidateLocation, verifyCandidateCheckpoint } from './integration-candidate';
import { collectFiles, snapshotRevision } from './file-results';
import { workspaceResourcePath } from './workspace-file-policy';
import { collectWorkspaceDocuments } from './workspace-documents';
import { IntegrationEditing } from './integration-editing';
import { MutationAdmission } from './mutation-admission';
import { assertWorktreePointer } from './worktree-registration';
import { gitCommonDirectory, resolveGitRef } from '../projects/git-metadata';
import { inspectWorkspacePath } from './workspace-paths';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const host = randomUUID();
type RunInput = { requestKey: string; confirmed: true; candidateVersion: string };
/** CLI evidence belongs to a candidate, never to the work's verification records. */
@Injectable()
export class IntegrationVerification {
  private active = new Map<string, { abort: AbortController; row: any; release: () => void; settle: () => void }>();
  private admissions = new Map<string, { fingerprint: string; promise: Promise<any> }>();
  constructor(@Inject(WorkStore) private store: WorkStore, @Inject(WorkService) private works: WorkService,
    @Inject(ProjectResolver) private resolver: ProjectResolver, @Inject(WorkspaceSettingsService) private settings: WorkspaceSettingsService,
    @Inject(DesktopLifecycle) private lifecycle: DesktopLifecycle, @Inject(IntegrationEditing) private editing: IntegrationEditing) {
    desktopHealth(store).register('candidate-verification', work => {
      const active = [...this.active.values()].find(item => item.row.workId === work.id);
      if (active) return active.row.status === 'running' ? 'active' : 'unknown';
      if (this.rows(work.id).some(row => row.processTerminated !== true)) return 'unknown';
      return undefined;
    });
    // Restart is observation only. A persisted PID is neither a handle nor proof of completion.
    for (const work of store.list()) for (const row of this.rows(work.id).filter(row => row.status === 'running')) {
      this.save({ ...row, status: 'interrupted', error: '서버 재시작으로 후보 검증 종료를 확인할 수 없습니다. 자동 재실행하지 않습니다.' });
    }
  }
  private rows(workId: string, candidateId?: string) { return this.store.records(workId, 'candidate-verification').filter(row => candidateId === undefined || row.candidateId === candidateId); }
  private request(workId: string, candidateId: string) {
    const work = this.works.get(workId), request = this.store.integrationRequests().find(row => row.workId === workId && row.candidateId === candidateId);
    if (!request || request.projectPath !== work.projectPath || request.workspaceId !== work.workspace?.workspaceId) throw new NotFoundException('업무에 연결된 후보가 없습니다');
    return { work, request };
  }
  private plan(request: IntegrationRequest): OperationRequest { return { kind: 'workspace', root: request.executionPath, commonDir: request.commonDir, refs: [`refs/heads/${candidateBranch(request)}`] }; }
  private save(row: any) { this.store.record(row.id, row.workId, 'candidate-verification', row); }
  private read(root: string, args: string[]) { return runGit(root, ['-c', 'core.fsmonitor=false', ...args]).then(buffer => buffer.toString()); }
  private source(work: Work, root: string) {
    const files = collectFiles(root, () => false, true);
    return hash([files, Object.keys(files).map(path => [path, lstatSync(join(root, path)).mode & 0o777])]);
  }
  /** Conversation state and updatedAt do not change the candidate's execution policy. */
  private workPolicy(work: Work) {
    return [work.id, work.sourceId, work.projectPath, work.changeName, work.phase, work.executionPath, work.workspace, work.reviewedVersion, work.reviewedPlanRevision, work.sourceMutationVersion, work.verificationScope, work.workVerificationCommands, work.verificationCommands, work.completedCommands, work.browserScenario];
  }
  private verificationPlan(work: Work, request: IntegrationRequest) {
    const changed = request.candidateCommit ? readGitSync(request.executionPath, ['diff', '--name-only', '-z', request.targetHead, request.candidateCommit, '--']).split('\0').filter(Boolean).map(path => {
      if (/(^|\/)package\.json$/.test(path)) try { return { path, before: readGitSync(request.executionPath, ['show', request.targetHead + ':' + path]), after: readGitSync(request.executionPath, ['show', request.candidateCommit + ':' + path]) }; } catch { /* New or deleted package changes require the broader plan. */ }
      return { path };
    }) : [];
    return { ...this.works.execution.requiredPlan(work, changed, request.executionPath, request.verificationScope), choiceVersion: hash([this.workPolicy(work), request]) };
  }
  async selectPlan(workId: string, candidateId: string, body: any) {
    if (!body || Object.keys(body).some(key => !['requestKey', 'confirmed', 'choiceVersion', 'scope'].includes(key)) || typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(body.requestKey) || body.confirmed !== true || !['work', 'full'].includes(body.scope) || typeof body.choiceVersion !== 'string') throw new BadRequestException('검증 범위와 현재 선택 기준을 확인해 주세요');
    const id = 'verification-plan:' + hash([workId, candidateId, body.requestKey]), fingerprint = hash(body);
    const prior = this.store.records(workId, 'candidate-verification-plan').find(row => row.id === id);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new ConflictException('같은 요청 키의 내용이 다릅니다'); return prior; }
    this.lifecycle.assertUnlocked(); desktopHealth(this.store).assertExecutionAllowed();
    const { work, request } = this.request(workId, candidateId);
    if (!['validating', 'ready'].includes(request.status) || this.rows(workId, candidateId).some(row => row.status === 'running' || row.processTerminated !== true)) throw new ConflictException('후보 실행·종료 확인을 마친 뒤 범위를 선택해 주세요');
    if (this.verificationPlan(work, request).choiceVersion !== body.choiceVersion) throw new ConflictException('검증 선택 기준이 변경되었습니다. 다시 조회해 주세요');
    const release = projectCoordinator(this.store).acquireOperation(this.plan(request));
    try {
      projectCoordinator(this.store).assertRecovery(this.plan(request));
      const row = { id, fingerprint, status: 'selected', scope: body.scope };
      this.store.transaction(() => {
        const current = this.request(workId, candidateId);
        if (hash([this.workPolicy(current.work), current.request]) !== body.choiceVersion) throw new ConflictException('검증 선택 기준이 변경되었습니다');
        this.store.record(request.id, workId, 'integration-request', { ...current.request, verificationScope: body.scope, status: 'validating', verificationRefs: [], updatedAt: new Date().toISOString() });
        this.store.record(id, workId, 'candidate-verification-plan', row);
      });
      return row;
    } finally { release(); }
  }
  private preparation(work: Work) {
    const records = ['workspace-preparation', 'workspace-local-policy', 'workspace-local-preparation', 'workspace-local-private'].map(kind => [kind, this.store.records(work.id, kind)]);
    return { policyVersion: work.workspace?.preparationPolicyVersion ?? null, policyDigest: work.workspace?.preparationPolicyDigest ?? null, localOnlyPaths: work.workspace?.localOnlyPaths ?? [], recordsVersion: hash(records) };
  }
  /** Pure synchronous filesystem/DB fence, used again inside the publication transaction. */
  private stamp(work: Work, request: IntegrationRequest) {
    const current = this.request(work.id, request.candidateId);
    if (hash(current.request) !== hash(request) || hash(this.workPolicy(current.work)) !== hash(this.workPolicy(work))) throw new ConflictException('후보 세대 또는 검증 정책이 변경되었습니다');
    candidateLocation(request, this.settings.protectedPaths());
    const file = (path: string) => {
      if (!existsSync(path)) return null;
      inspectWorkspacePath(dirname(path), []); const stat = lstatSync(path);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new ConflictException('검증 checkpoint 파일 소유가 변경되었습니다');
      return stat.isDirectory() ? [stat.dev, stat.ino, stat.mtimeMs] : [stat.dev, stat.ino, hash(readFileSync(path).toString('base64'))];
    };
    const roots = [request.projectPath, request.workExecutionPath, request.executionPath];
    const refs = new Set([`refs/heads/${request.targetBranch}`, `refs/heads/${work.workspace!.branch}`, `refs/heads/${candidateBranch(request)}`]);
    const metadata = roots.map(root => {
      inspectWorkspacePath(root, []); const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root || gitCommonDirectory(root) !== request.commonDir) throw new ConflictException('검증 공간 경계가 변경되었습니다');
      const pointer = join(root, '.git'), pointerStat = lstatSync(pointer);
      let directory = pointer;
      if (pointerStat.isFile()) {
        const text = readFileSync(pointer, 'utf8').trim(); if (!text.startsWith('gitdir: ')) throw new ConflictException('검증 Git 포인터가 변경되었습니다');
        directory = resolve(root, text.slice(8)); assertWorktreePointer(root, request.commonDir);
      } else if (pointerStat.isSymbolicLink() || !pointerStat.isDirectory()) throw new ConflictException('검증 Git 경계가 변경되었습니다');
      inspectWorkspacePath(directory, []);
      const head = readFileSync(join(directory, 'HEAD'), 'utf8').trim();
      if (head.startsWith('ref: ')) { const ref = head.slice(5); refs.add(ref); refs.add(resolveGitRef(root, ref, directory)); }
      const names = ['HEAD', 'index', 'gitdir', 'commondir', 'config', 'config.worktree', 'locked', 'prunable', 'MERGE_HEAD', 'AUTO_MERGE', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'MERGE_AUTOSTASH', 'sequencer', 'rebase-merge', 'rebase-apply'];
      return [root, stat.dev, stat.ino, pointerStat.isFile() ? file(pointer) : null, names.map(name => [name, file(join(directory, name))])];
    });
    const related = [...refs].sort().map(ref => { const resolved = resolveGitRef(request.projectPath, ref); refs.add(resolved); return [ref, file(join(request.commonDir, ref)), resolved, file(join(request.commonDir, resolved))]; });
    const packedPath = join(request.commonDir, 'packed-refs'); file(packedPath);
    const packed = existsSync(packedPath) ? readFileSync(packedPath, 'utf8').split('\n').filter(line => refs.has(line.trim().split(' ')[1])) : [];
    const owners = [join(request.managedPath, 'identity.json'), join(dirname(request.executionPath), 'identity.json'), join(dirname(request.workExecutionPath), 'identity.json')].map(path => [path, file(path)]);
    const commands = this.verificationPlan(work, request).commands;
    return hash([this.workPolicy(work), this.preparation(work), this.works.execution.candidateCommandContext(commands), request, metadata, related, packed, owners, roots.map(root => this.source(work, root)), commands, ['integration-preparation', 'integration-edit'].map(kind => this.store.records(work.id, kind))]);
  }
  private async capture(workId: string, candidateId: string, requireClean: boolean) {
    const { work, request } = this.request(workId, candidateId);
    if (!['validating', 'ready'].includes(request.status) || !request.candidateCommit || !request.resultCommit) throw new ConflictException('충돌 해결과 새 후보 커밋을 먼저 완료해 주세요');
    const selected = this.resolver.resolve(work.sourceId, workId, candidateId);
    if (selected.root !== request.executionPath) throw new ConflictException('후보 실행 경로가 변경되었습니다');
    await this.editing.assertGitRead(work.sourceId, workId, candidateId);
    const preparation = this.store.records(workId, 'integration-preparation').find(row => row.candidateId === candidateId && ['validating', 'conflicted'].includes(row.status));
    const edits = this.store.records(workId, 'integration-edit');
    if (!preparation || preparation.commit !== request.candidateCommit && !edits.some(row => row.candidateId === candidateId && row.status === 'committed' && row.commit === request.candidateCommit)) throw new ConflictException('후보 커밋의 준비·편집 소유 근거가 없습니다');
    const commands = this.verificationPlan(work, request).commands;
    if (!commands.length) throw new ConflictException('변경 관련 검증 명령을 등록하거나 전체 검증을 명시적으로 선택해 주세요. 미실행은 통과가 아닙니다');
    const planRevision = this.works.planVersion(work, request.workExecutionPath);
    if (!work.reviewedVersion || planRevision !== work.reviewedVersion || request.reviewedVersion !== work.reviewedVersion) throw new ConflictException('최신 계획 검토가 필요합니다');
    if (snapshotRevision(this.works.execution.snapshot(work, request.workExecutionPath)) !== request.sourceRevision) throw new ConflictException('업무 결과 커밋 밖의 실제 소스가 변경되었습니다');
    const fixed = hash([this.workPolicy(work), request.id, request.fingerprint, request.candidateId, request.candidateCommit, request.candidateMutationVersion, request.targetHead, request.resultCommit, commands]);
    const startingStamp = this.stamp(work, request);
    const before = [this.source(work, request.executionPath), this.source(work, request.workExecutionPath), this.source(work, request.projectPath)];
    const [index, workIndex, originalIndex, workHead, originalHead, targetHead, untracked, flags, tree, format, textConfig, debug] = await Promise.all([
      this.read(request.executionPath, ['ls-files', '--stage', '-z']), this.read(request.workExecutionPath, ['ls-files', '--stage', '-z']), this.read(request.projectPath, ['ls-files', '--stage', '-z']),
      this.read(request.workExecutionPath, ['rev-parse', 'HEAD']), this.read(request.projectPath, ['rev-parse', 'HEAD']), this.read(request.projectPath, ['rev-parse', '--verify', `refs/heads/${request.targetBranch}^{commit}`]),
      this.read(request.executionPath, ['ls-files', '--others', '--exclude-standard', '-z']), this.read(request.executionPath, ['ls-files', '-v', '-z']),
      this.read(request.executionPath, ['ls-tree', '-r', '-z', request.candidateCommit]), this.read(request.executionPath, ['rev-parse', '--show-object-format']),
      this.read(request.executionPath, ['config', '--null', '--get-regexp', '^core[.](autocrlf|filemode|eol|safecrlf)$']), this.read(request.executionPath, ['ls-files', '--debug', '-z']),
    ]);
    if (workHead.trim() !== request.resultCommit || targetHead.trim() !== request.targetHead) throw new ConflictException('현재 업무 결과 HEAD 또는 원본 대상 HEAD가 변경되었습니다. 후보를 다시 준비해 주세요');
    if (flags.split('\0').filter(Boolean).some(row => row[0] === 'S' || /[a-z]/.test(row[0]))) throw new ConflictException('후보 assume-unchanged/skip-worktree를 먼저 정리해 주세요');
    const entries = index.split('\0').filter(Boolean).filter(row => !workspaceResourcePath(work, row.slice(row.indexOf('\t') + 1))), tracked = entries.map(row => row.slice(row.indexOf('\t') + 1)).sort();
    const headEntries = tree.split('\0').filter(Boolean).map(row => { const at = row.indexOf('\t'), [mode, , blob] = row.slice(0, at).split(' '); return `${mode} ${blob} 0\t${row.slice(at + 1)}`; }).filter(row => !workspaceResourcePath(work, row.slice(row.indexOf('\t') + 1)));
    if (!['sha1', 'sha256'].includes(format.trim())) throw new ConflictException('후보 Git object 형식을 지원하지 않습니다');
    const config = new Map(textConfig.split('\0').filter(Boolean).map(field => { const at = field.indexOf('\n'); if (at < 0) throw new ConflictException('후보 Git 텍스트 정책을 확인할 수 없습니다'); return [field.slice(0, at).toLowerCase(), field.slice(at + 1).toLowerCase()]; }));
    const boolean = (value: string | undefined) => ['false', 'no', 'off', '0'].includes(value ?? '') ? 'false' : ['true', 'yes', 'on', '1', ''].includes(value ?? 'true') ? 'true' : value ?? 'true';
    const attributes = readGitTextAttributes(request.executionPath, tracked);
    let clean = !untracked.split('\0').filter(Boolean).some(path => !workspaceResourcePath(work, path)) && entries.every(row => /^\d+ [a-f0-9]+ 0\t/.test(row)) && hash([...entries].sort()) === hash(headEntries.sort());
    if (clean) try { readCleanTrackedFiles(request.executionPath, tracked, { format: format.trim(), autocrlf: config.get('core.autocrlf') === 'input' ? 'input' : boolean(config.get('core.autocrlf') ?? 'false'), filemode: boolean(config.get('core.filemode')), attributes: attributes.attributes, cachedSizes: parseGitCachedSizes(debug), index: new Map(entries.map(row => { const at = row.indexOf('\t'), [mode, blob] = row.slice(0, at).split(' '); return [row.slice(at + 1), { mode, blob }]; })) }); } catch { clean = false; }
    if (requireClean && !clean) throw new ConflictException('후보의 staged·unstaged·untracked 변경을 새 후보 커밋으로 먼저 기록해 주세요');
    const checkpoint = await verifyCandidateCheckpoint(request, this.settings.protectedPaths(), request.candidateCommit, undefined, false, index);
    const again = await Promise.all([
      this.read(request.workExecutionPath, ['ls-files', '--stage', '-z']), this.read(request.projectPath, ['ls-files', '--stage', '-z']),
      this.read(request.workExecutionPath, ['rev-parse', 'HEAD']), this.read(request.projectPath, ['rev-parse', 'HEAD']), this.read(request.projectPath, ['rev-parse', '--verify', `refs/heads/${request.targetBranch}^{commit}`]),
    ]);
    if (hash(again) !== hash([workIndex, originalIndex, workHead, originalHead, targetHead])) throw new ConflictException('후보 검증 확인 중 원본·업무 index 또는 HEAD가 변경되었습니다');
    const current = this.request(workId, candidateId);
    if (fixed !== hash([this.workPolicy(current.work), current.request.id, current.request.fingerprint, current.request.candidateId, current.request.candidateCommit, current.request.candidateMutationVersion, current.request.targetHead, current.request.resultCommit, this.verificationPlan(current.work, current.request).commands]) || hash(before) !== hash([this.source(work, request.executionPath), this.source(work, request.workExecutionPath), this.source(work, request.projectPath)]) || this.stamp(work, request) !== startingStamp) throw new ConflictException('후보 검증 기준을 읽는 중 소스·소유·명령이 변경되었습니다');
    const runtime = this.works.execution.candidateCommandContext(commands);
    const readPolicy = { attributesVersion: attributes.version, textConfigVersion: hash(textConfig), objectFormat: format.trim() };
    const checkPublication = () => this.stamp(work, request) === startingStamp && readGitTextAttributes(request.executionPath, tracked).version === attributes.version && readGitSync(request.executionPath, ['-c', 'core.fsmonitor=false', 'config', '--null', '--get-regexp', '^core[.](autocrlf|filemode|eol|safecrlf)$']) === textConfig;
    if (!checkPublication()) throw new ConflictException('후보 속성 또는 텍스트 정책이 수집 중 변경되었습니다');
    const basis = { verificationScope: this.verificationPlan(work, request).scope, targetKind: 'integration-candidate', candidateId, candidateEpoch: request.candidateMutationVersion ?? null, candidateCommit: checkpoint.head, workHead: workHead.trim(), targetRef: `refs/heads/${request.targetBranch}`, targetHead: targetHead.trim(), originalHead: originalHead.trim(), source: before, index: hash(index), workIndex: hash(workIndex), originalIndex: hash(originalIndex), planRevision, reviewedVersion: work.reviewedVersion, sourceMutationVersion: work.sourceMutationVersion ?? null, workPolicyVersion: hash(this.workPolicy(work)), preparation: this.preparation(work), runtime, runtimeVersion: hash(runtime), candidatePlan: collectWorkspaceDocuments(request.executionPath, work.changeName).planRevision, originalPlan: collectWorkspaceDocuments(request.projectPath, work.changeName).planRevision, commandVersion: hash(commands), browserVersion: hash(work.browserScenario ?? null), readPolicy, clean };
    return { work, request, commands, basis, version: hash(basis), checkPublication };
  }
  private publish(work: Work, request: IntegrationRequest, ready: boolean, refs: string[], records: any[], check?: () => boolean) {
    let accepted = false;
    this.store.transaction(() => {
      const current = this.request(request.workId, request.candidateId);
      if (hash(current.request) !== hash(request) || hash(this.workPolicy(current.work)) !== hash(this.workPolicy(work)) || hash(this.rows(work.id, request.candidateId)) !== hash(records) || check && !check() || !['validating', 'ready'].includes(current.request.status) || ready && !check) return;
      accepted = true;
      if (current.request.status === (ready ? 'ready' : 'validating') && hash(current.request.verificationRefs) === hash(refs)) return;
      this.store.record(request.id, request.workId, 'integration-request', { ...current.request, status: ready ? 'ready' : 'validating', verificationRefs: refs, updatedAt: new Date().toISOString() });
    });
    return accepted;
  }
  async results(workId: string, candidateId: string) {
    const { work, request } = this.request(workId, candidateId); let version: string | undefined, error: string | undefined;
    const running = this.rows(workId, candidateId).some(row => row.status === 'running');
    let check: (() => boolean) | undefined;
    if (!running) try { const captured = await this.capture(workId, candidateId, false); version = captured.version; check = captured.checkPublication; } catch (failure: any) { error = failure.message; }
    return this.render(work, request, version, error, check);
  }
  private async render(work: Work, request: IntegrationRequest, version?: string, error?: string, check?: () => boolean) {
    const workId = work.id, candidateId = request.candidateId;
    const running = this.rows(workId, candidateId).some(row => row.status === 'running');
    const records = this.rows(workId, candidateId), runs = records.map(row => ({ ...row, fresh: !!version && row.candidateVersion === version && row.processTerminated === true }));
    const latest = runs.at(-1); let cliPassed = latest?.status === 'passed' && latest.fresh === true;
    const browserRequired = !!work.browserScenario, browser = this.works.browser;
    const browserVersion = browserRequired ? browser?.evidenceVersion(workId, candidateId) : undefined;
    let browserProof: Awaited<ReturnType<typeof browser.capturePassedProof>> | undefined, browserStatus = browserRequired ? 'not-run-for-candidate' : 'not-required';
    if (browserRequired && cliPassed) try { browserProof = await browser.capturePassedProof(workId, candidateId); browserStatus = 'passed'; } catch (failure: any) { browserStatus = 'stale-or-unverified'; error = failure.message; }
    let ready = !!cliPassed && (!browserRequired || !!browserProof);
    const publication = check ? () => { if (!check() || browserRequired && browser.evidenceVersion(workId, candidateId) !== browserVersion) return false; try { browserProof?.assertUnchanged(); return true; } catch { return false; } } : undefined;
    const verificationRefs = ready ? [latest.id, ...(browserProof ? [browserProof.row.id] : [])] : [];
    let accepted = true;
    if (!running) try { accepted = this.publish(work, request, ready, verificationRefs, records, publication); } catch { accepted = false; }
    if (!accepted) { ready = cliPassed = false; for (const row of runs) row.fresh = false; error = '검증 조회 뒤 후보 세대·소스·정책 또는 새 검증 근거가 변경되었습니다'; }
    let verificationPlan: ReturnType<IntegrationVerification['verificationPlan']> | undefined; try { verificationPlan = this.verificationPlan(this.request(workId, candidateId).work, this.request(workId, candidateId).request); } catch { /* Missing candidate remains blocked. */ }
    return { candidateId, verificationPlan, targetKind: 'integration-candidate', runs, ready, cliPassed: !!cliPassed, browserRequired, browserStatus, browserRunId: browserProof?.row.id ?? null, ...(error ? { error } : {}) };
  }
  async preview(workId: string, candidateId: string) {
    const captured = await this.capture(workId, candidateId, true);
    projectCoordinator(this.store).assertRecovery(this.plan(captured.request));
    const status = await this.render(captured.work, captured.request, captured.version, undefined, captured.checkPublication);
    return { ...status, candidateVersion: captured.version, commands: captured.commands, results: status.runs, executionPath: captured.request.executionPath, basis: captured.basis };
  }
  /** Fresh, read-only evidence for final integration checks. Never publishes ready/stale state. */
  async captureReadyProof(workId: string, candidateId: string) {
    const captured = await this.capture(workId, candidateId, true), records = this.rows(workId, candidateId), latest = records.at(-1);
    if (!latest || latest.status !== 'passed' || latest.processTerminated !== true || latest.candidateVersion !== captured.version || records.some(row => row.status === 'running' || row.processTerminated !== true)) throw new ConflictException('최신 후보의 필수 검증 통과 근거가 필요합니다');
    const browserProof = captured.work.browserScenario ? await this.works.browser.capturePassedProof(workId, candidateId) : undefined;
    const recordsVersion = hash(records);
    const assertUnchanged = () => {
      if (!captured.checkPublication() || hash(this.rows(workId, candidateId)) !== recordsVersion) throw new ConflictException('후보 또는 필수 검증 기준이 변경되었습니다');
      browserProof?.assertUnchanged();
    };
    assertUnchanged();
    return { ...captured, verificationRefs: [latest.id as string, ...(browserProof ? [browserProof.row.id as string] : [])], recordsVersion, assertUnchanged };
  }
  private parse(body: any): RunInput {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['requestKey', 'confirmed', 'candidateVersion'].includes(key)) || typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(body.requestKey) || body.confirmed !== true || typeof body.candidateVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.candidateVersion)) throw new BadRequestException('요청 키·후보 버전·명시 확인이 필요합니다');
    return { requestKey: body.requestKey, confirmed: true, candidateVersion: body.candidateVersion };
  }
  run(workId: string, candidateId: string, body: unknown) {
    const input = this.parse(body), key = hash([workId, candidateId, input.requestKey]), fingerprint = hash(input), pending = this.admissions.get(key);
    if (pending) { if (pending.fingerprint !== fingerprint) throw new ConflictException('같은 요청 키의 내용이 다릅니다'); return pending.promise; }
    const promise = this.runOnce(workId, candidateId, input).finally(() => this.admissions.delete(key));
    this.admissions.set(key, { fingerprint, promise }); return promise;
  }
  private async runOnce(workId: string, candidateId: string, body: unknown) {
    const input = this.parse(body), fingerprint = hash(input), id = `candidate-verification:${hash([workId, candidateId, input.requestKey])}`;
    this.request(workId, candidateId);
    const exists = () => this.rows(workId, candidateId).some(row => row.id === id);
    const previous = this.rows(workId, candidateId).find(row => row.id === id);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new ConflictException('같은 요청 키의 내용이 다릅니다'); return previous; }
    return new MutationAdmission(this.store, workId, `candidate-verification:${candidateId}`, input.requestKey, fingerprint, exists).run(async admission => {
      this.lifecycle.assertUnlocked(); desktopHealth(this.store).assertExecutionAllowed();
      let release: (() => void) | undefined, settle: (() => void) | undefined;
      try {
        settle = this.lifecycle.beginRequest('candidate-verification', workId);
        const captured = await this.capture(workId, candidateId, true);
        this.lifecycle.assertUnlocked();
        if (captured.version !== input.candidateVersion) throw new ConflictException('후보 검증 버전이 변경되었습니다');
        const plan = this.plan(captured.request); release = projectCoordinator(this.store).acquireOperation(plan);
        const checked = await this.capture(workId, candidateId, true);
        if (checked.version !== captured.version) throw new ConflictException('후보 검증 준비 중 기준이 변경되었습니다');
        const latest = this.rows(workId, candidateId).at(-1);
        if (latest?.status === 'passed' && latest.processTerminated === true && latest.candidateVersion === checked.version && latest.commands?.length === checked.commands.length && latest.commands.every((result: any, index: number) => result.status === 'passed' && result.cacheable === true && result.processTerminated === true && result.terminationEvidence === 'job-and-worker-closed' && result.commandVersion === JSON.stringify(checked.commands[index]))) {
          if (!checked.checkPublication()) throw new ConflictException('재사용 확인 중 검증 기준이 변경되었습니다');
          const receipt = { ...latest, id, fingerprint, requestKey: input.requestKey, reusedFrom: latest.id, createdAt: new Date().toISOString() };
          this.store.transaction(() => { admission.admit(); this.save(receipt); });
          return receipt;
        }
        const row: any = { id, workId, candidateId, fingerprint, requestKey: input.requestKey, targetKind: 'integration-candidate', candidateVersion: checked.version, basis: checked.basis, commands: [], status: 'running', processTerminated: false, owner: host, ownerProcessId: process.pid, runGeneration: randomUUID(), createdAt: new Date().toISOString(), intentId: `${id}:scope` };
        this.store.transaction(() => {
          projectCoordinator(this.store).assertRecovery(plan); if (!checked.checkPublication()) throw new ConflictException('검증 예약 직전 기준이 변경되었습니다'); admission.admit(); this.save(row);
          this.store.record(row.intentId, workId, 'workspace-git-intent', { scope: plan.kind, root: plan.root, commonDir: plan.commonDir, refs: plan.refs, status: 'running', stage: 'candidate-verification', candidateId, owner: host, ownerProcessId: process.pid, runGeneration: row.runGeneration, runId: row.id, fingerprint: row.fingerprint });
          this.store.record(checked.request.id, workId, 'integration-request', { ...checked.request, status: 'validating', verificationRefs: [], updatedAt: new Date().toISOString() });
        });
        const abort = new AbortController(), heldRelease = release, heldSettle = settle;
        this.active.set(id, { abort, row, release: heldRelease, settle: heldSettle }); release = settle = undefined;
        void this.execute(checked, row, abort, heldRelease, heldSettle);
        return row;
      } finally { try { release?.(); } finally { settle?.(); } }
    });
  }
  private async execute(captured: Awaited<ReturnType<IntegrationVerification['capture']>>, row: any, abort: AbortController, release: () => void, settle: () => void) {
    let completed: Awaited<ReturnType<IntegrationVerification['capture']>> | undefined;
    try {
      for (const command of captured.commands) {
        if (abort.signal.aborted) { row.status = 'interrupted'; break; }
        const before = await this.capture(row.workId, row.candidateId, true);
        if (before.version !== row.candidateVersion) { row.status = 'stale'; break; }
        const result = await this.works.execution.runCandidateCommand(row.id, captured.request.executionPath, command, abort.signal, pid => {
          row.processId = pid; row.processTerminated = false;
          this.store.transaction(() => {
            this.save(row); const intent = this.store.records(row.workId, 'workspace-git-intent').find(item => item.id === row.intentId)!;
            this.store.record(row.intentId, row.workId, 'workspace-git-intent', { ...intent, processId: pid });
          });
        });
        row.commands.push(result); row.processTerminated = result.processTerminated; this.save(row);
        if (!result.processTerminated || result.status !== 'passed') { row.status = result.status; break; }
        completed = await this.capture(row.workId, row.candidateId, false);
        if (completed.version !== row.candidateVersion) { row.status = 'stale'; break; }
      }
      if (row.status === 'running') row.status = abort.signal.aborted ? 'interrupted' : row.commands.length === captured.commands.length ? 'passed' : 'blocked';
    } catch (error: any) { row.status = row.commands.length ? 'stale' : 'blocked'; row.error = error.message; }
    // No child was started if the before-command checkpoint blocked execution.
    if (!row.processId) row.processTerminated = true;
    row.endedAt = new Date().toISOString();
    let durable = false;
    try {
      this.store.transaction(() => {
        this.save(row); const intent = this.store.records(row.workId, 'workspace-git-intent').find(item => item.id === row.intentId)!;
        this.store.record(row.intentId, row.workId, 'workspace-git-intent', { ...intent, processId: row.processId, status: row.processTerminated ? row.status : 'uncertain', terminationUnconfirmed: !row.processTerminated });
      }); durable = true;
      if (row.processTerminated) await this.render(completed?.work ?? captured.work, completed?.request ?? captured.request, completed?.version, undefined, completed?.checkPublication);
    } catch { /* Durable running intent survives lost publication; never start another command. */ }
    finally {
      if (row.processTerminated && durable) { this.active.delete(row.id); try { release(); } finally { settle(); } }
    }
  }
  private control(workId: string, candidateId: string, body: any, reconcile: boolean) {
    this.request(workId, candidateId);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['runId', ...(reconcile ? ['confirmed'] : [])].includes(key)) || typeof body.runId !== 'string' || reconcile && body.confirmed !== true) throw new BadRequestException('검증 실행 식별과 명시 확인을 확인해 주세요');
    const row = this.rows(workId, candidateId).find(item => item.id === body.runId); if (!row) throw new NotFoundException('후보 검증 기록이 없습니다');
    return row;
  }
  cancel(workId: string, candidateId: string, body: unknown) {
    const row = this.control(workId, candidateId, body, false), active = this.active.get(row.id);
    if (active?.row.status === 'running') { active.abort.abort(); return { ...row, cancelRequested: true }; }
    return { ...row, cancelRequested: false, ...(row.processTerminated !== true ? { error: '소유 실행 핸들이 없어 종료를 추정하거나 PID로 중단하지 않습니다' } : {}) };
  }
  reconcile(workId: string, candidateId: string, body: unknown) {
    const row = this.control(workId, candidateId, body, true);
    const active = this.active.get(row.id);
    const intent = this.store.records(workId, 'workspace-git-intent').find(item => item.id === row.intentId);
    const matches = (a: any, b: any) => ['id', 'workId', 'candidateId', 'fingerprint', 'owner', 'ownerProcessId', 'runGeneration', 'processId', 'intentId'].every(key => a[key] === b[key]);
    const intentMatches = !!intent && intent.stage === 'candidate-verification' && intent.runId === row.id && intent.candidateId === row.candidateId && intent.fingerprint === row.fingerprint && intent.owner === row.owner && intent.ownerProcessId === row.ownerProcessId && intent.runGeneration === row.runGeneration && intent.processId === row.processId;
    const last = active?.row.commands.at(-1);
    const liveReceipt = !!active && active.row.status !== 'running' && active.row.owner === host && active.row.ownerProcessId === process.pid && typeof active.row.runGeneration === 'string' && matches(active.row, row) && active.row.processTerminated === true && last?.processTerminated === true && ['not-started', 'waiting-worker-closed', 'job-and-worker-closed'].includes(last.terminationEvidence);
    if (!intentMatches || active?.row.status === 'running' || row.processTerminated !== true && !liveReceipt || active && !matches(active.row, row)) return { ...row, reconciliation: 'termination-unconfirmed' };
    const expectedRow = hash(row), expectedIntent = hash(intent), expectedMemory = active ? hash(active.row) : undefined;
    // Live evidence is the exact completed ChildProcess/Job generation, never a PID lookup.
    // A lost receipt is preserved as interrupted, even when the CLI itself exited zero.
    const next = liveReceipt && row.processTerminated !== true
      ? { ...active!.row, status: 'interrupted', processTerminated: true, error: '소유 실행의 종료는 확인했으나 검증 결과 저장이 끊겨 중단 기록으로 보존했습니다' }
      : { ...row, status: row.status === 'running' ? 'interrupted' : row.status };
    this.store.transaction(() => {
      const current = this.rows(workId, candidateId).find(item => item.id === row.id), currentIntent = this.store.records(workId, 'workspace-git-intent').find(item => item.id === row.intentId);
      if (hash(current) !== expectedRow || hash(currentIntent) !== expectedIntent || active && (this.active.get(row.id) !== active || hash(active.row) !== expectedMemory)) throw new ConflictException('종료 확인 중 소유 세대 또는 요청 기록이 변경되었습니다');
      this.save(next);
      this.store.record(intent!.id, workId, 'workspace-git-intent', { ...intent, status: next.status, terminationUnconfirmed: false });
    });
    if (active) { this.active.delete(row.id); try { active.release(); } finally { active.settle(); } }
    return { ...next, reconciliation: 'observed' };
  }
}
