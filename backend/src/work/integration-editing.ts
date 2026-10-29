import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WorkStore, type IntegrationRequest, type Work } from './store';
import { WorkService } from './work.service';
import { WorkspaceSettingsService } from './workspace-settings.service';
import { DesktopLifecycle } from '../desktop/lifecycle';
import { ProjectResolver } from '../projects/resolver';
import { ProjectFiles } from '../projects/files';
import { GitError, runGit } from '../projects/git-runner';
import { projectCoordinator } from '../projects/coordinator';
import type { OperationRequest } from '../projects/operation-locks';
import { collectFiles, excludedNames } from './file-results';
import { workspaceResourcePath, workspaceSourcePolicy } from './workspace-file-policy';
import { assertCandidateProgress, assertCandidateAutoMerge, candidateAutoMerge, candidateBranch, verifyCandidateCheckpoint, verifyCandidateRegistration } from './integration-candidate';
import { IntegrationPreparation, type EditingBasisProof } from './integration-preparation';
import { inspectWorkspacePath } from './workspace-paths';
import { MutationAdmission } from './mutation-admission';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const oid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const sourceHash = (source: Record<string, unknown>) => hash(Object.entries(source).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
// PID-only observations never release a live/reused PID. Group 9.2 can enrich this versioned
// owner evidence with kernel creation time/executable identity without adopting legacy claims.
const hostOwner = { version: 1, processId: process.pid, instanceId: randomUUID(), evidence: 'pid-only', recordedAt: new Date().toISOString() };
const requestProof = Symbol('candidate-edit-request-proof');
type Mode = 'conflict' | 'revision';
type Entry = { path: string; index: string; worktree: string; selectable: boolean };
type Input = { requestKey: string; confirmed: true; candidateVersion: string; paths: string[]; message?: string };
const forbidden = (work: Work, path: string) => workspaceResourcePath(work, path) || path.split('/').some(part => excludedNames.includes(part.toLowerCase())) || path.endsWith('.tsbuildinfo');
export class CandidateGitReadBlocked extends ConflictException {}

/** Candidate-only edits. Generic ProjectGit's merge/rebase gate is intentionally unchanged. */
@Injectable()
export class IntegrationEditing {
  private files: ProjectFiles;
  private preparation: IntegrationPreparation;
  constructor(@Inject(WorkStore) private store: WorkStore, @Inject(WorkService) private works: WorkService,
    @Inject(ProjectResolver) private resolver: ProjectResolver, @Inject(WorkspaceSettingsService) private settings: WorkspaceSettingsService,
    @Inject(DesktopLifecycle) private lifecycle: DesktopLifecycle) {
    this.files = new ProjectFiles(workspaceSourcePolicy(store));
    this.preparation = new IntegrationPreparation(store, works, settings, lifecycle);
  }
  private run(root: string, args: string[], optional = false) { return runGit(root, ['-c', 'core.fsmonitor=false', '--no-pager', ...args], {}, optional); }
  private async text(root: string, args: string[], optional = false) { return (await this.run(root, args, optional)).toString().trim(); }
  private request(workId: string, candidateId: string) {
    const work = this.works.get(workId), selected = this.resolver.resolve(work.sourceId, workId, candidateId);
    if (!selected.candidate) throw new ConflictException('소유 후보가 없습니다');
    return { request: selected.candidate, work };
  }
  private plan(request: IntegrationRequest): OperationRequest {
    return { kind: 'management', root: request.executionPath, commonDir: request.commonDir, spaces: [request.executionPath, request.workExecutionPath], refs: [`refs/heads/${candidateBranch(request)}`, `refs/heads/${request.targetBranch}`, `refs/heads/${this.works.get(request.workId).workspace?.branch}`] };
  }
  private async attributes(request: Pick<IntegrationRequest, 'executionPath'>, paths: string[]) {
    const values = new Map<string, Record<string, string>>();
    for (let offset = 0; offset < paths.length;) {
      const batch: string[] = []; let size = 0;
      while (offset < paths.length && batch.length < 100 && size + paths[offset].length < 16000) { size += paths[offset].length + 3; batch.push(paths[offset++]); }
      if (!batch.length) throw new ConflictException('후보 속성 경로 길이 한도를 초과했습니다');
      const fields = (await this.run(request.executionPath, ['check-attr', '-z', 'filter', 'working-tree-encoding', 'ident', 'text', 'eol', '--', ...batch])).toString().split('\0');
      for (let n = 0; n + 2 < fields.length; n += 3) {
        const row = values.get(fields[n]) ?? {}; row[fields[n + 1]] = fields[n + 2]; values.set(fields[n], row);
        if (['filter', 'working-tree-encoding', 'ident'].includes(fields[n + 1]) && !['unspecified', 'unset'].includes(fields[n + 2])) throw new CandidateGitReadBlocked('후보에 적용되는 clean 필터·인코딩·ident 변환은 지원하지 않습니다');
      }
    }
    return values;
  }
  async assertGitRead(sourceId: string, workId: string, candidateId: string) {
    const selected = this.resolver.resolve(sourceId, workId, candidateId), request = selected.candidate!;
    await this.assertRootGitRead(selected.root);
    if (hash(this.resolver.resolve(sourceId, workId, candidateId).candidate) !== hash(request)) throw new ConflictException('후보 Git 조회 중 소유 상태가 변경되었습니다');
  }
  /** The caller must first pin and verify ownership of this root. No status/clean conversion precedes this guard. */
  async assertRootGitRead(root: string) {
    try {
      const paths = [...new Set((await this.run(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).toString().split('\0').filter(Boolean))];
      await this.attributes({ executionPath: root }, paths);
    } catch (error) { if (error instanceof GitError) throw new CandidateGitReadBlocked('후보 Git 속성 검사를 확인할 수 없어 변환을 실행하지 않습니다'); throw error; }
  }
  private async state(workId: string, candidateId: string, gitChecks = false, proof?: EditingBasisProof) {
    const { request, work } = this.request(workId, candidateId), root = request.executionPath;
    const rawIndex = () => {
      const pointer = readFileSync(join(root, '.git'), 'utf8').trim();
      if (!pointer.startsWith('gitdir: ')) throw new ConflictException('후보 index 포인터가 변경되었습니다');
      const path = join(resolve(root, pointer.slice(8)), 'index');
      inspectWorkspacePath(dirname(path), []); const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new ConflictException('후보 index의 소유가 변경되었습니다');
      return hash(readFileSync(path).toString('base64'));
    };
    const startingIndex = rawIndex();
    const origin = this.store.records(workId, 'integration-preparation').find(row => row.candidateId === candidateId);
    if (!origin || typeof origin.basisContext !== 'string' || !/^[a-f0-9]{64}$/.test(origin.basisContext) || !['conflicted', 'validating'].includes(origin.status)) throw new ConflictException('원래 후보 준비의 소유·검증 근거를 확인해 주세요');
    const basis = await this.editingBasis(request, proof, request.workExecutionPath);
    if (origin.basisContext !== basis.context) throw new ConflictException('원래 후보 준비의 업무·계획·검증 근거가 변경되었습니다');
    const mode: Mode = request.status === 'conflicted' ? 'conflict' : 'revision';
    assertCandidateAutoMerge(root, origin, mode === 'revision');
    if (mode === 'conflict' && !origin.conflicts?.length) throw new ConflictException('소유 충돌 준비 근거가 없습니다');
    if (mode === 'revision' && origin.commit !== request.candidateCommit && !this.store.records(workId, 'integration-edit').some(row => row.candidateId === candidateId && row.status === 'committed' && row.commit === request.candidateCommit)) throw new ConflictException('후보 commit의 준비·해결 계보가 다릅니다');
    const index = (await this.run(root, ['ls-files', '--stage', '-z'])).toString();
    const source = collectFiles(root, path => forbidden(work, path), true);
    const tracked = index.split('\0').filter(Boolean).map(row => row.slice(row.indexOf('\t') + 1));
    const modes = () => Object.keys(source).map(path => [path, lstatSync(join(root, path)).mode & 0o777]);
    const fileModes = modes();
    if (gitChecks) await this.attributes(request, [...new Set([...tracked, ...Object.keys(source)])]);
    const config = (await this.run(root, ['config', '--null', '--get-regexp', '^(core[.](autocrlf|eol|safecrlf|filemode|attributesfile)|filter[.])'], true)).toString();
    // Raw FS edits must remain able to repair .gitattributes; status can run clean filters.
    const raw = gitChecks ? (await this.run(root, ['status', '--porcelain=v1', '--no-renames', '-z', '--untracked-files=all'])).toString() : '';
    const entries: Entry[] = raw.split('\0').filter(Boolean).map(row => ({ path: row.slice(3), index: row[0], worktree: row[1], selectable: !forbidden(work, row.slice(3)) }));
    const flags = (await this.run(root, ['ls-files', '-v', '-z'])).toString().split('\0').filter(Boolean);
    if (flags.some(row => !forbidden(work, row.slice(2)) && (row[0] === 'S' || /[a-z]/.test(row[0])))) throw new ConflictException('후보의 assume-unchanged/skip-worktree를 먼저 정리해 주세요');
    if (Object.keys(source).length > 10000 || entries.length > 10000 || gitChecks && Object.keys(source).some(path => !tracked.includes(path) && !entries.some(entry => entry.path === path))) throw new ConflictException('Git에 표시되지 않는 후보 소스 또는 파일 한도를 확인해 주세요');
    const head = await this.text(root, ['rev-parse', 'HEAD']);
    if (head !== (mode === 'conflict' ? request.targetHead : request.candidateCommit)) throw new ConflictException('후보 HEAD가 변경되었습니다');
    const mergeHead = mode === 'conflict' ? request.resultCommit! : null;
    const current = this.store.integrationRequests().find(row => row.id === request.id)!;
    if ((await this.editingBasis(current, basis.proof, request.workExecutionPath)).context !== basis.context) throw new ConflictException('후보 조회 중 업무 근거가 변경되었습니다');
    const checkpoint = await verifyCandidateCheckpoint(request, this.settings.protectedPaths(), head, mergeHead ?? undefined, false, index);
    assertCandidateAutoMerge(root, origin, mode === 'revision', checkpoint.gitDir);
    basis.proof.checkSync?.();
    if (hash(this.store.integrationRequests().find(row => row.id === request.id)) !== hash(request) || hash(collectFiles(root, path => forbidden(work, path), true)) !== hash(source) || hash(fileModes) !== hash(modes()) || rawIndex() !== startingIndex) throw new ConflictException('후보 조회 중 상태가 변경되었습니다');
    const contentKey = hash([mode, head, mergeHead, source, fileModes, index, config]);
    return { request, work, proof: basis.proof, autoMergeCaptured: true, autoMerge: mode === 'conflict' ? origin.autoMerge : null, basisContext: basis.context, mode, head, mergeHead, source, index, entries, contentKey, candidateVersion: hash([request, basis.context, contentKey]) };
  }
  private async editingBasis(request: IntegrationRequest, proof?: EditingBasisProof, validatedRoot?: string) {
    try { return await this.preparation.editingBasis(request, proof, validatedRoot); }
    catch (error: any) { if (['ENOENT', 'ENOTDIR'].includes(error?.code)) throw new ConflictException('고정 업무·계획 문서가 없어 후보 편집 근거를 확인할 수 없습니다'); throw error; }
  }
  async preview(workId: string, candidateId: string) {
    const state = await this.state(workId, candidateId, true); projectCoordinator(this.store).assertRecovery(this.plan(state.request));
    return { candidateId, candidateVersion: state.candidateVersion, mode: state.mode, head: state.head, entries: state.entries, conflicts: state.request.conflicts, selectionMode: 'whole-file' };
  }
  async file(sourceId: string, workId: string, candidateId: string, path: string) {
    const root = this.resolver.resolve(sourceId, workId, candidateId).root, file = await this.files.read(root, path);
    try {
      const state = await this.state(workId, candidateId); projectCoordinator(this.store).assertRecovery(this.plan(state.request));
      const current = await this.files.read(root, path);
      if (file.version !== current.version) throw new ConflictException('파일이 변경되었습니다');
      return { ...file, version: hash([candidateId, path, file.version, state.candidateVersion]), candidateVersion: state.candidateVersion, mode: state.mode };
    } catch (error: any) { return { ...file, editable: false, reason: error.message }; }
  }
  async entry(sourceId: string, workId: string, candidateId: string, path: string) {
    const root = this.resolver.resolve(sourceId, workId, candidateId).root, entry = await this.files.entry(root, path);
    try {
      const state = await this.state(workId, candidateId); projectCoordinator(this.store).assertRecovery(this.plan(state.request));
      const current = await this.files.entry(root, path); if (entry.version !== current.version) throw new ConflictException('후보 항목이 변경되었습니다');
      return { ...entry, version: hash([candidateId, path, entry.version, state.candidateVersion]), candidateVersion: state.candidateVersion, mode: state.mode };
    } catch (error: any) { return { ...entry, editable: false, reason: error.message }; }
  }
  private parse(body: any, commit: boolean): Input {
    const keys = ['requestKey', 'confirmed', 'candidateVersion', 'paths', ...(commit ? ['message'] : [])];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key)) || typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(body.requestKey) || body.confirmed !== true || typeof body.candidateVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.candidateVersion) || !Array.isArray(body.paths) || !commit && !body.paths.length || body.paths.length > 10000 || body.paths.some((path: any) => typeof path !== 'string' || !path || path.length > 4096 || /[\0\\]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))) || new Set(body.paths).size !== body.paths.length || commit && (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 10000 || body.message.includes('\0'))) throw new BadRequestException('후보 버전·선택 파일·요청 키·명시 확인을 입력해 주세요');
    return { requestKey: body.requestKey, confirmed: true, candidateVersion: body.candidateVersion, paths: [...body.paths].sort(), ...(commit ? { message: body.message } : {}) };
  }
  private save(row: any) { this.store.record(row.id, row.workId, 'integration-edit', row); }
  private invalidate(request: IntegrationRequest) {
    const next = { ...request, candidateMutationVersion: randomUUID(), verificationRefs: [], status: request.status === 'ready' ? 'validating' as const : request.status, updatedAt: new Date().toISOString() };
    this.store.record(request.id, request.workId, 'integration-request', next); return next;
  }
  private reserve(state: Awaited<ReturnType<IntegrationEditing['state']>>, row: any, admission?: MutationAdmission) {
    this.store.transaction(() => {
      if (this.store.records(row.workId, 'integration-edit').some(item => item.id === row.id) || hash(this.store.integrationRequests().find(item => item.id === state.request.id)) !== hash(state.request)) throw new ConflictException('후보 요청 또는 상태가 다른 실행에 의해 변경되었습니다');
      projectCoordinator(this.store).assertRecovery(this.plan(state.request));
      admission?.admit();
      row.request = this.invalidate(state.request); state.proof.request = row.request; this.save(row);
      this.store.record(row.intentId, row.workId, 'workspace-git-intent', { ...this.intent(state.request), status: 'running' });
    });
  }
  private intent(request: IntegrationRequest) { const plan = this.plan(request); return { scope: plan.kind, root: plan.root, commonDir: plan.commonDir, affectedRoots: plan.spaces, refs: plan.refs }; }
  private async unchanged(row: any, contentKey: string) {
    const current = await this.state(row.workId, row.candidateId, row.gitChecks === true, row[requestProof]);
    if (hash(current.request) !== hash(row.request) || current.basisContext !== row.basisContext || current.contentKey !== contentKey) throw new ConflictException('후보 소스·index·계획·검증 기준이 변경되었습니다');
    return current;
  }
  async saveFile(sourceId: string, workId: string, candidateId: string, body: any) {
    this.resolver.resolve(sourceId, workId, candidateId);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['path', 'content', 'version', 'candidateVersion'].includes(key)) || typeof body.path !== 'string' || typeof body.content !== 'string' || typeof body.version !== 'string') throw new BadRequestException('후보 파일과 CAS 버전이 필요합니다');
    const checked = await this.state(workId, candidateId), original = await this.files.read(checked.request.executionPath, body.path);
    if (body.version !== hash([candidateId, body.path, original.version, checked.candidateVersion]) || body.candidateVersion !== undefined && body.candidateVersion !== checked.candidateVersion) throw new ConflictException({ message: '후보 또는 파일 버전이 변경되었습니다', latest: { ...original, version: hash([candidateId, body.path, original.version, checked.candidateVersion]), candidateVersion: checked.candidateVersion, mode: checked.mode } });
    return this.execute(workId, candidateId, 'file', { requestKey: randomUUID(), confirmed: true, candidateVersion: checked.candidateVersion, paths: [body.path] }, async (row, state) => {
      const file = await this.files.read(state.request.executionPath, body.path);
      if (body.version !== hash([candidateId, body.path, file.version, state.candidateVersion]) || body.candidateVersion !== undefined && body.candidateVersion !== state.candidateVersion) throw new ConflictException({ message: '후보 또는 파일 버전이 변경되었습니다', latest: { ...file, version: hash([candidateId, body.path, file.version, state.candidateVersion]), candidateVersion: state.candidateVersion, mode: state.mode } });
      await this.unchanged(row, state.contentKey);
      let saved;
      try { saved = await this.files.save(state.request.executionPath, { path: body.path, content: body.content, version: file.version }); }
      catch (error) {
        if (error instanceof ConflictException) {
          const latestState = await this.state(workId, candidateId, false, row[requestProof]), latest = await this.files.read(state.request.executionPath, body.path);
          throw new ConflictException({ message: '후보 파일이 외부에서 변경되었습니다', latest: { ...latest, version: hash([candidateId, body.path, latest.version, latestState.candidateVersion]), candidateVersion: latestState.candidateVersion, mode: latestState.mode } });
        }
        throw error;
      }
      const after = await this.state(workId, candidateId, false, row[requestProof]), wanted = { ...state.source, [body.path]: after.source[body.path] };
      if (after.index !== state.index || sourceHash(after.source) !== sourceHash(wanted) || after.basisContext !== state.basisContext || hash(after.request) !== hash(row.request)) throw new ConflictException('후보 파일 저장 중 다른 내용이 변경되었습니다');
      row.status = 'saved'; row.finalContentKey = after.contentKey; return { ...saved, candidateVersion: after.candidateVersion, version: hash([candidateId, body.path, saved.version, after.candidateVersion]), mode: after.mode };
    }, checked);
  }
  async mutateEntry(sourceId: string, workId: string, candidateId: string, kind: 'create' | 'move' | 'delete', body: any) {
    this.resolver.resolve(sourceId, workId, candidateId);
    const keys = kind === 'create' ? ['path', 'kind', 'content', 'candidateVersion'] : kind === 'move' ? ['path', 'target', 'version', 'candidateVersion'] : ['path', 'version', 'confirmed', 'candidateVersion'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key)) || typeof body.path !== 'string' || kind === 'create' && (!['file', 'directory'].includes(body.kind) || typeof body.candidateVersion !== 'string') || kind === 'move' && typeof body.target !== 'string' || kind !== 'create' && typeof body.version !== 'string' || kind === 'delete' && body.confirmed !== true) throw new BadRequestException('후보 항목·CAS 버전·명시 확인이 필요합니다');
    const checked = await this.state(workId, candidateId), root = checked.request.executionPath, guard = this.files.validationScope(root);
    guard(body.path, { missing: kind === 'create' }); if (kind === 'move') guard(body.target, { missing: true });
    if (forbidden(checked.work, body.path) || kind === 'move' && forbidden(checked.work, body.target)) throw new ConflictException('비밀·고정 로컬 자원은 후보에서 변경할 수 없습니다');
    const original = kind === 'create' ? null : await this.files.entry(root, body.path);
    if (body.candidateVersion !== undefined && body.candidateVersion !== checked.candidateVersion || original && body.version !== hash([candidateId, body.path, original.version, checked.candidateVersion])) throw new ConflictException('후보 항목 버전이 변경되었습니다');
    if (kind === 'create' && existsSync(join(root, body.path))) throw new ConflictException('후보 대상 경로가 이미 있습니다');
    if (kind === 'delete' && original?.kind !== 'file') throw new BadRequestException('후보 파일을 하나씩 명시적으로 삭제해 주세요');
    if (kind === 'move') this.checkMove(checked.work, root, body.path, body.target);
    return this.execute(workId, candidateId, kind, { requestKey: randomUUID(), confirmed: true, candidateVersion: checked.candidateVersion, paths: [body.path, ...(kind === 'move' ? [body.target] : [])] }, async (row, state) => {
      const before = kind === 'create' ? null : await this.files.entry(root, body.path);
      if (before && body.version !== hash([candidateId, body.path, before.version, state.candidateVersion])) throw new ConflictException('후보 항목이 외부에서 변경되었습니다');
      await this.unchanged(row, state.contentKey);
      if (kind === 'move') this.checkMove(state.work, root, body.path, body.target);
      const result = kind === 'create' ? await this.files.create(root, body) : kind === 'move' ? await this.files.move(root, { ...body, version: before!.version! }) : await this.files.remove(root, { ...body, version: before!.version! });
      const after = await this.state(workId, candidateId, false, row[requestProof]), wanted = { ...state.source };
      if (kind === 'create' && body.kind === 'file') wanted[body.path] = after.source[body.path];
      if (kind === 'delete') delete wanted[body.path];
      if (kind === 'move') for (const path of Object.keys(state.source)) if (path === body.path || path.startsWith(body.path + '/')) { delete wanted[path]; wanted[body.target + path.slice(body.path.length)] = state.source[path]; }
      if (after.index !== state.index || sourceHash(after.source) !== sourceHash(wanted) || after.basisContext !== state.basisContext || hash(after.request) !== hash(row.request)) throw new ConflictException('후보 항목 변경 중 선택 밖 소스·index가 변경되었습니다');
      row.status = 'saved'; row.finalContentKey = after.contentKey;
      if (kind === 'delete') return { ...result, candidateVersion: after.candidateVersion, mode: after.mode };
      const path = kind === 'move' ? body.target : body.path, next = await this.files.entry(root, path);
      return { ...result, version: hash([candidateId, path, next.version, after.candidateVersion]), candidateVersion: after.candidateVersion, mode: after.mode };
    }, checked);
  }
  private checkMove(work: Work, root: string, source: string, target: string) {
    const guard = this.files.validationScope(root); let count = 0; const deadline = Date.now() + 1500;
    const visit = (from: string, to: string, depth: number) => {
      if (++count > 3000 || depth > 128 || Date.now() > deadline) throw new ConflictException('후보 이동 검사 한도를 초과했습니다. 작은 범위를 선택해 주세요');
      guard(from); guard(to, { missing: true });
      if (forbidden(work, from) || forbidden(work, to)) throw new ConflictException('보호·고정 로컬 자원으로 들어가거나 나오는 하위 경로를 이동할 수 없습니다');
      const stat = lstatSync(join(root, from));
      if (stat.isDirectory()) for (const name of readdirSync(join(root, from))) visit(`${from}/${name}`, `${to}/${name}`, depth + 1);
    };
    visit(source, target, 0);
  }
  async stage(workId: string, candidateId: string, body: unknown) { return this.operation(workId, candidateId, this.parse(body, false), false); }
  async commit(workId: string, candidateId: string, body: unknown) { return this.operation(workId, candidateId, this.parse(body, true), true); }
  private readBytes(root: string, path: string) {
    this.files.validate(root, path, { missing: true }); const absolute = join(root, path);
    if (!existsSync(absolute)) return null;
    const before = lstatSync(absolute); if (!before.isFile() || before.nlink !== 1 || before.isSymbolicLink() || before.size > 8 * 1024 * 1024) throw new ConflictException('독립 일반 파일과 8 MiB 선택 한도를 확인해 주세요');
    const fd = openSync(absolute, 'r');
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev) throw new ConflictException('읽기 전에 파일 소유가 변경되었습니다');
      const bytes = readFileSync(fd), after = lstatSync(absolute);
      if (opened.ino !== before.ino || opened.dev !== before.dev || after.ino !== before.ino || after.dev !== before.dev || after.nlink !== 1 || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new ConflictException('읽는 중 파일 소유가 변경되었습니다');
      return bytes;
    } finally { closeSync(fd); }
  }
  private indexEntries(index: string) { return index.split('\0').filter(Boolean).map(row => { const tab = row.indexOf('\t'), [mode, blob, stage] = row.slice(0, tab).split(' '); return { path: row.slice(tab + 1), mode, blob, stage }; }); }
  private async operation(workId: string, candidateId: string, input: Input, commit: boolean) {
    return this.execute(workId, candidateId, commit ? 'commit' : 'stage', input, async (row, state, mutate) => {
      const root = state.request.executionPath, selected = new Set(input.paths);
      if (commit && !input.paths.length && state.mode !== 'conflict') throw new ConflictException('변경 없는 일반 후보 커밋은 만들지 않습니다');
      const guard = this.files.validationScope(root); input.paths.forEach(path => { guard(path, { missing: true }); if (forbidden(state.work, path) || !state.entries.some(entry => entry.path === path && entry.selectable)) throw new ConflictException('현재 후보 변경 파일만 선택해 주세요'); });
      if (commit && (state.entries.some(entry => entry.selectable && !selected.has(entry.path) || !entry.selectable && entry.index !== ' ' && entry.index !== '?') || this.indexEntries(state.index).some(entry => entry.stage !== '0'))) throw new ConflictException('모든 후보 변경과 충돌 파일 전체를 stage한 뒤 선택해 주세요');
      const attrs = await this.attributes(state.request, input.paths), format = await this.text(root, ['rev-parse', '--show-object-format']), autocrlf = await this.text(root, ['config', '--get', 'core.autocrlf'], true), filemode = await this.text(root, ['config', '--bool', '--get', 'core.filemode'], true);
      const initial = this.indexEntries(state.index), desired = new Map<string, string | null>();
      for (const path of input.paths) {
        let bytes = this.readBytes(root, path);
        if (!bytes) { desired.set(path, null); continue; }
        const values = attrs.get(path)!;
        if (values.text !== 'unset' && (['set', 'auto'].includes(values.text) || ['lf', 'crlf'].includes(values.eol) || ['true', 'input'].includes(autocrlf)) && !bytes.includes(0)) bytes = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
        const blob = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        const diskMode = lstatSync(join(root, path)).mode & 0o111 ? '100755' : '100644';
        const mode = filemode === 'false' ? initial.find(entry => entry.path === path && ['0', '2'].includes(entry.stage))?.mode ?? diskMode : diskMode;
        if (!['100644', '100755'].includes(mode)) throw new ConflictException('일반 파일 mode만 지원합니다');
        desired.set(path, `${mode} ${blob} 0\t${path}`);
      }
      await this.unchanged(row, state.contentKey);
      const wanted = initial.filter(entry => !selected.has(entry.path)).map(entry => `${entry.mode} ${entry.blob} ${entry.stage}\t${entry.path}`);
      for (const value of desired.values()) if (value) wanted.push(value);
      if (!commit) {
        await mutate('stage', ['add', '-A', `--pathspec-from-file=${row.pathspec}`, '--pathspec-file-nul']);
        const after = await this.state(workId, candidateId, true, row[requestProof]);
        if (hash(after.source) !== hash(state.source) || after.basisContext !== state.basisContext || hash(after.request) !== hash(row.request) || hash(after.index.split('\0').filter(Boolean).sort()) !== hash(wanted.sort())) throw new ConflictException('선택한 전체 파일과 실제 stage 결과가 다릅니다');
        row.status = 'staged'; row.finalContentKey = after.contentKey; row.afterVersion = after.candidateVersion; return row;
      }
      if (hash(wanted.sort()) !== hash(state.index.split('\0').filter(Boolean).sort())) throw new ConflictException('선택한 전체 파일과 staged 내용·mode가 다릅니다');
      row.parents = state.mode === 'conflict' ? [state.request.targetHead, state.request.resultCommit!] : [state.head]; row.startHead = state.head; row.mode = state.mode; row.source = state.source; row.index = state.index;
      row.tree = (await mutate('tree', ['write-tree'])).toString().trim(); this.save(row);
      const actual = (await this.run(root, ['ls-tree', '-r', '-z', row.tree])).toString().split('\0').filter(Boolean).map(value => { const tab = value.indexOf('\t'), [mode, , blob] = value.slice(0, tab).split(' '), path = value.slice(tab + 1); return `${mode} ${blob} 0\t${path}`; });
      if (hash(actual.sort()) !== hash(wanted.sort())) throw new ConflictException('선택 내용과 immutable tree가 다릅니다');
      await this.unchanged(row, state.contentKey);
      row.marker = `${input.message}\n\nOpenSpecBoard candidate ${candidateId} edit ${row.id}`;
      row.commitObject = (await mutate('commit-object', ['commit-tree', row.tree, ...row.parents.flatMap((parent: string) => ['-p', parent]), '-m', row.marker])).toString().trim(); this.save(row);
      if (!oid(row.commitObject)) throw new ConflictException('결과 commit OID가 없습니다');
      await this.unchanged(row, state.contentKey);
      row.casStarted = true; this.save(row);
      await mutate('commit-ref', ['update-ref', '--no-deref', `refs/heads/${candidateBranch(state.request)}`, row.commitObject, state.head]); row.casCompleted = true; this.save(row);
      await this.observeCommit(row, true);
      if (state.mode === 'conflict') await mutate('merge-finish', ['merge', '--quit']);
      await this.observeCommit(row, false); row.status = 'committed'; row.commit = row.commitObject;
      return row;
    });
  }
  private async observeCommit(row: any, allowMerge: boolean) {
    const current = this.store.integrationRequests().find(request => request.id === row.request.id)!;
    if (!current || hash(current) !== hash(row.request) || !['conflicted', 'validating', 'ready', 'uncertain'].includes(current.status)) throw new ConflictException('후보 저장 상태가 변경되었습니다');
    const work = this.works.get(row.workId);
    const active = this.store.integrationRequests().filter(request => request.workId === work.id && !['cancelled', 'removed', 'applied'].includes(request.status));
    if (['completed', 'archived'].includes(work.phase) || active.length !== 1 || active[0].id !== current.id || current.candidateId !== row.candidateId || this.works.execution.executionPath(work) !== current.workExecutionPath || work.sourceId !== row.sourceId || work.workspace?.workspaceId !== current.workspaceId || work.workspace?.projectId !== current.projectId) throw new ConflictException('소유 업무 관계가 다릅니다');
    const registration = verifyCandidateRegistration(current, this.settings.protectedPaths()), root = current.executionPath;
    if (registration.head !== row.commitObject || await this.text(root, ['rev-parse', 'HEAD^{tree}']) !== row.tree || await this.text(root, ['show', '-s', '--format=%P', row.commitObject]) !== row.parents.join(' ') || await this.text(root, ['show', '-s', '--format=%B', row.commitObject]) !== row.marker.trim()) throw new ConflictException('실제 후보 OID·부모·marker·tree가 다릅니다');
    const mergeHead = assertCandidateProgress(root, allowMerge && row.mode === 'conflict' ? current.resultCommit : undefined, allowMerge);
    if (row.processTerminated !== true) throw new ConflictException('소유 Git 프로세스의 종료를 먼저 확인해 주세요');
    // Absence is an observation, not permission to clean metadata. Exact commit/tree/
    // parents/marker/basis checks still run; only a remaining owned merge may be quit.
    if (mergeHead) assertCandidateAutoMerge(root, row);
    else if (candidateAutoMerge(root) !== null) throw new ConflictException('남아 있는 AUTO_MERGE를 보존합니다');
    const basis = await this.editingBasis(current, row[requestProof], current.workExecutionPath); row[requestProof] = basis.proof;
    if (hash(collectFiles(root, path => forbidden(work, path), true)) !== hash(row.source) || (await this.run(root, ['ls-files', '--stage', '-z'])).toString() !== row.index || basis.context !== row.basisContext) throw new ConflictException('커밋 중 후보 소스·index·업무 검증이 변경되었습니다');
    if (await this.observed(current) !== row.observed || hash(this.store.integrationRequests().find(request => request.id === current.id)) !== hash(current)) throw new ConflictException('원본·업무 ref/index 또는 후보 저장 기준이 변경되었습니다');
    const checkpoint = await verifyCandidateCheckpoint(current, this.settings.protectedPaths(), row.commitObject, allowMerge && row.mode === 'conflict' ? current.resultCommit! : undefined, allowMerge, row.index);
    if (mergeHead) assertCandidateAutoMerge(root, row, false, checkpoint.gitDir);
    else if (candidateAutoMerge(root, checkpoint.gitDir) !== null) throw new ConflictException('최종 관찰 중 AUTO_MERGE가 변경되었습니다');
    (row[requestProof] as EditingBasisProof | undefined)?.checkSync?.();
    if (hash(collectFiles(root, path => forbidden(work, path), true)) !== hash(row.source) || hash(this.store.integrationRequests().find(request => request.id === current.id)) !== hash(current)) throw new ConflictException('커밋 최종 확인 중 후보 근거가 변경되었습니다');
  }
  private async observed(request: IntegrationRequest) { return hash([await this.text(request.projectPath, ['rev-parse', 'HEAD']), (await this.run(request.projectPath, ['ls-files', '--stage', '-z'])).toString(), await this.text(request.workExecutionPath, ['rev-parse', 'HEAD']), (await this.run(request.workExecutionPath, ['ls-files', '--stage', '-z'])).toString()]); }
  private async replay(row: any, fingerprint: string) {
    if (row.fingerprint !== fingerprint) throw new ConflictException('같은 후보 요청 키에 다른 내용을 사용할 수 없습니다');
    if (row.status === 'failed') return row;
    if (row.status === 'staged') { let fresh = false; try { fresh = (await this.state(row.workId, row.candidateId, true)).candidateVersion === row.afterVersion; } catch {} return { ...row, fresh, superseded: !fresh }; }
    if (row.processId && !row.processTerminated) return { ...row, status: 'uncertain', error: '기존 소유 프로세스의 실제 종료를 먼저 확인해 주세요' };
    if (!row.commitObject) return { ...row, status: 'uncertain', error: '자동 재실행하지 않습니다. 실제 후보 상태를 확인해 주세요' };
    try {
      const current = this.store.integrationRequests().find(request => request.id === row.request.id);
      if (row.status === 'committed' && current?.candidateCommit === row.commitObject) {
        await this.observeCommit({ ...row, request: current }, false); return row;
      }
      await this.observeCommit(row, false); row.status = 'committed'; row.commit = row.commitObject; this.finish(row); return row;
    } catch { return { ...row, status: 'uncertain', error: '실제 후보 commit·병합 종료·검증 근거를 확인해야 합니다. 자동 재실행하지 않습니다' }; }
  }
  /** Explicit observation/finalization only; never reruns add, commit-tree, CAS, merge, reset or abort. */
  async reconcile(workId: string, candidateId: string, body: any) {
    this.lifecycle.assertUnlocked(); const settle = this.lifecycle.beginRequest('candidate-reconcile', workId); let delegated = false;
    try { return await this.reconcileRequest(workId, candidateId, body, () => { delegated = true; }, settle); }
    finally { if (!delegated) settle(); }
  }
  private async reconcileRequest(workId: string, candidateId: string, body: any, takeOwnership: () => void, settle: () => void) {
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['requestKey', 'confirmed'].includes(key)) || body.confirmed !== true || typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(body.requestKey)) throw new BadRequestException('기존 요청 키와 실제 상태 재확인이 필요합니다');
    const id = `candidate-edit:${hash([workId, candidateId, body.requestKey])}`, row = this.store.records(workId, 'integration-edit').find(item => item.id === id);
    if (!row) throw new ConflictException('소유 후보 요청 기록이 없습니다. 자동 재실행하지 않습니다');
    const observed = await this.replay(row, row.fingerprint);
    if (observed.status !== 'uncertain') return observed;
    if (row.status === 'committed') return observed;
    if (!row.commitObject) return observed;
    if (!row.processTerminated || row.recoveryToken) {
      // A missing PID is evidence; liveness, EPERM and an absent saved PID never authorize guessing.
      if (row.recoveryToken) {
        if (!row.recoveryOwnerProcessId) return observed;
        try { process.kill(row.recoveryOwnerProcessId, 0); return observed; } catch (error: any) { if (error.code !== 'ESRCH') return observed; }
      }
      if (!row.processTerminated) {
        if (!row.processId) return observed;
        try { process.kill(row.processId, 0); return observed; } catch (error: any) { if (error.code !== 'ESRCH') return observed; }
        if (row.status === 'running' && row.ownerProcessId) try { process.kill(row.ownerProcessId, 0); return observed; } catch (error: any) { if (error.code !== 'ESRCH') return observed; }
      }
      this.store.transaction(() => {
        if (hash(this.store.records(workId, 'integration-edit').find(item => item.id === id)) !== hash(row)) throw new ConflictException('소유 프로세스 확인 중 기록이 변경되었습니다');
        row.processTerminated = true; delete row.recoveryToken; delete row.recoveryOwnerProcessId; this.save(row);
      });
    }
    const token = randomUUID(), intentId = `${id}:observe:${token}`;
    let reserved = false, directory: string | undefined, owned: { dev: number; ino: number } | undefined;
    takeOwnership();
    try {
      // Existing lifetime ownership remains held. Only this exact operation's intents are excluded.
      const own = new Set([row.intentId, ...row.intentIds]);
      this.store.transaction(() => {
        if (hash(this.store.records(workId, 'integration-edit').find(item => item.id === id)) !== hash(row)) throw new ConflictException('다른 재확인이 진행 중입니다');
        for (const work of this.store.list()) for (const intent of this.store.records(work.id, 'workspace-git-intent')) {
          if (own.has(intent.id) || !['running', 'uncertain'].includes(intent.status)) continue;
          if (intent.commonDir === row.request.commonDir) throw new ConflictException('같은 저장소의 다른 프로세스·관리 작업을 먼저 확인해 주세요');
        }
        row.recoveryToken = token; row.recoveryOwnerProcessId = process.pid; row.recoveryOwner = hostOwner; row.intentIds.push(intentId); this.save(row);
        this.store.record(intentId, workId, 'workspace-git-intent', { ...this.intent(row.request), status: 'running', stage: 'explicit-merge-finalization' });
      }); reserved = true;
      await this.observeCommit(row, true);
      const mergeHead = await this.text(row.request.executionPath, ['rev-parse', '--verify', 'MERGE_HEAD'], true);
      if (mergeHead) {
        if (row.mode !== 'conflict' || mergeHead !== row.request.resultCommit) throw new ConflictException('소유 병합 종료 근거가 다릅니다');
        const data = resolve(process.env.DATA_DIR || '../.data'); inspectWorkspacePath(data, []); directory = mkdtempSync(join(data, 'candidate-observe-')); owned = lstatSync(directory);
        assertCandidateProgress(row.request.executionPath, row.request.resultCommit); assertCandidateAutoMerge(row.request.executionPath, row);
        row.processTerminated = false; this.save(row);
        try {
          await runGit(row.request.executionPath, ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${directory}`, 'merge', '--quit'], { timeoutMs: 10000, onSpawn: pid => { row.processId = pid; this.store.transaction(() => { this.save(row); this.store.record(intentId, workId, 'workspace-git-intent', { ...this.intent(row.request), status: 'running', stage: 'explicit-merge-finalization', processId: pid }); }); } });
          row.processTerminated = true; row.mergeFinished = true; this.save(row);
        } catch (error) { row.processTerminated = error instanceof GitError && !error.terminationUnconfirmed; throw error; }
      }
      await this.observeCommit(row, false); row.status = 'committed'; row.commit = row.commitObject; delete row.recoveryToken; delete row.recoveryOwnerProcessId; this.finish(row); return row;
    } catch (error: any) {
      if (!reserved) throw error;
      row.status = 'uncertain'; row.error = error.message;
      this.store.transaction(() => {
        const current = this.store.records(workId, 'integration-edit').find(item => item.id === id);
        if (current?.recoveryToken !== token || current.recoveryOwnerProcessId !== process.pid || current.recoveryOwner?.instanceId !== hostOwner.instanceId) throw new ConflictException('명시 관찰 소유가 변경되어 다른 claim은 보존합니다');
        this.save(row); this.store.record(intentId, workId, 'workspace-git-intent', { ...this.intent(row.request), stage: 'explicit-merge-finalization', status: 'uncertain', terminationUnconfirmed: row.processTerminated === false, processId: row.processId });
      }); return row;
    } finally {
      // Observer ownership ends with this handler. Child ownership remains durable.
      if (reserved) try {
        this.store.transaction(() => {
          const current = this.store.records(workId, 'integration-edit').find(item => item.id === id);
          if (current?.recoveryToken !== token || current.recoveryOwnerProcessId !== process.pid || current.recoveryOwner?.instanceId !== hostOwner.instanceId) return;
          delete current.recoveryToken; delete current.recoveryOwnerProcessId;
          this.save(current); delete row.recoveryToken; delete row.recoveryOwnerProcessId;
        });
      } catch { /* An unconfirmed DB write never clears another observer or child intent. */ }
      if (directory && owned && row.processTerminated !== false) try { const stat = lstatSync(directory); if (stat.dev === owned.dev && stat.ino === owned.ino && !stat.isSymbolicLink() && realpathSync(directory) === resolve(directory)) rmdirSync(directory); } catch { /* Never recursively remove unknown recovery contents. */ }
      if (row.processTerminated === false && row.processId) { const pid = row.processId; const timer = setInterval(() => { try { process.kill(pid, 0); } catch (error: any) { if (error.code === 'ESRCH') { clearInterval(timer); settle(); } } }, 1000); timer.unref(); } else settle();
    }
  }
  private finish(row: any) {
    this.store.transaction(() => {
      const current = this.store.integrationRequests().find(request => request.id === row.request.id);
      if (!current || hash(current) !== hash(row.request)) throw new ConflictException('후보 결과 저장 중 상태가 변경되었습니다');
      if (row.status === 'committed') this.store.record(current.id, row.workId, 'integration-request', { ...current, status: 'validating', candidateCommit: row.commitObject, conflicts: [], verificationRefs: [], updatedAt: new Date().toISOString() });
      this.save(row);
      for (const intent of this.store.records(row.workId, 'workspace-git-intent').filter(intent => intent.id === row.intentId || row.intentIds.includes(intent.id))) this.store.record(intent.id, row.workId, 'workspace-git-intent', { ...intent, status: 'passed', terminationUnconfirmed: false });
    });
  }
  private execute(workId: string, candidateId: string, kind: string, input: Input, action: (row: any, state: Awaited<ReturnType<IntegrationEditing['state']>>, mutate: (stage: string, args: string[]) => Promise<Buffer>) => Promise<any>, checked?: Awaited<ReturnType<IntegrationEditing['state']>>) {
    const id = `candidate-edit:${hash([workId, candidateId, input.requestKey])}`;
    const exists = () => this.store.records(workId, 'integration-edit').some(row => row.id === id) || this.store.records(workId, 'workspace-git-intent').some(row => row.id.startsWith(`${id}:`));
    if (!['stage', 'commit'].includes(kind) || exists()) return this.executeOnce(workId, candidateId, kind, input, action, checked);
    return new MutationAdmission(this.store, workId, `candidate-edit:${candidateId}`, input.requestKey, hash([kind, input]), exists).run(admission => this.executeOnce(workId, candidateId, kind, input, action, checked, admission));
  }
  private async executeOnce(workId: string, candidateId: string, kind: string, input: Input, action: (row: any, state: Awaited<ReturnType<IntegrationEditing['state']>>, mutate: (stage: string, args: string[]) => Promise<Buffer>) => Promise<any>, checked?: Awaited<ReturnType<IntegrationEditing['state']>>, admission?: MutationAdmission) {
    this.lifecycle.assertUnlocked();
    const id = `candidate-edit:${hash([workId, candidateId, input.requestKey])}`, fingerprint = hash([kind, input]);
    const existing = this.store.records(workId, 'integration-edit').find(row => row.id === id); if (existing) { const done = this.lifecycle.beginRequest('candidate-edit-query', workId); try { return await this.replay(existing, fingerprint); } finally { done(); } }
    this.lifecycle.assertUnlocked(); const settle = this.lifecycle.beginRequest('candidate-edit', workId);
    let release: (() => void) | undefined, row: any, reserved = false, directory: string | undefined, owned: { dev: number; ino: number } | undefined, ownedFile: { dev: number; ino: number } | undefined;
    try {
      const gitChecks = kind === 'stage' || kind === 'commit';
      let state = checked ?? await this.state(workId, candidateId, gitChecks);
      if (input.candidateVersion !== state.candidateVersion) throw new ConflictException('후보 버전이 변경되었습니다');
      release = projectCoordinator(this.store).acquireOperation(this.plan(state.request));
      state = await this.state(workId, candidateId, gitChecks, state.proof);
      if (input.candidateVersion !== state.candidateVersion) throw new ConflictException('후보 버전이 변경되었습니다');
      row = { id, workId, candidateId, sourceId: state.work.sourceId, ownerProcessId: process.pid, owner: hostOwner, kind, gitChecks, fingerprint, intentId: `${id}:reservation`, intentIds: [] as string[], status: 'running', autoMergeCaptured: state.autoMergeCaptured, autoMerge: state.autoMerge, basisContext: state.basisContext, observed: await this.observed(state.request), createdAt: new Date().toISOString() };
      row[requestProof] = state.proof; this.reserve(state, row, admission); reserved = true;
      const parent = resolve(process.env.DATA_DIR || '../.data'); inspectWorkspacePath(parent, []); mkdirSync(parent, { recursive: true });
      directory = mkdtempSync(join(parent, 'candidate-edit-')); owned = lstatSync(directory);
      row.pathspec = join(directory, 'paths.nul'); writeFileSync(row.pathspec, Buffer.from(input.paths.join('\0') + '\0'), { flag: 'wx' });
      const file = lstatSync(row.pathspec); ownedFile = file;
      const mutate = async (stage: string, args: string[]) => {
        if (stage === 'merge-finish') { assertCandidateProgress(state.request.executionPath, state.request.resultCommit!); assertCandidateAutoMerge(state.request.executionPath, row); }
        const dir = lstatSync(directory!), spec = lstatSync(row.pathspec);
        if (dir.dev !== owned!.dev || dir.ino !== owned!.ino || dir.isSymbolicLink() || realpathSync(directory!) !== resolve(directory!) || spec.dev !== file.dev || spec.ino !== file.ino || spec.nlink !== 1 || spec.isSymbolicLink() || !readFileSync(row.pathspec).equals(Buffer.from(input.paths.join('\0') + '\0'))) throw new ConflictException('호스트 선택 경로 소유가 변경되었습니다');
        const intentId = `${id}:git:${stage}`; row.intentIds.push(intentId); row.processTerminated = false;
        const intent: any = { ...this.intent(state.request), stage, status: 'running' };
        this.store.transaction(() => { this.save(row); this.store.record(intentId, workId, 'workspace-git-intent', intent); });
        try {
          const output = await runGit(state.request.executionPath, ['-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', `core.hooksPath=${directory}`, '-c', 'commit.gpgSign=false', '-c', 'user.name=OpenSpecBoard', '-c', 'user.email=integration@openspecboard.local', ...args], { timeoutMs: 10000, maxOutputBytes: 4 * 1024 * 1024, onSpawn: pid => { row.processId = intent.processId = pid; this.store.transaction(() => { this.save(row); this.store.record(intentId, workId, 'workspace-git-intent', intent); }); } });
          row.processTerminated = true; if (stage === 'merge-finish') row.mergeFinished = true;
          this.store.record(intentId, workId, 'workspace-git-intent', { ...intent, status: 'passed' }); this.save(row); return output;
        } catch (error: any) { row.processTerminated = error instanceof GitError && !error.terminationUnconfirmed; this.store.record(intentId, workId, 'workspace-git-intent', { ...intent, status: error instanceof GitError && !error.uncertain ? 'failed' : 'uncertain', terminationUnconfirmed: error?.terminationUnconfirmed === true }); throw error; }
      };
      const result = await action(row, state, mutate);
      if (await this.observed(row.request) !== row.observed) throw new ConflictException('원본·업무 ref/index가 변경되었습니다');
      if (row.status === 'committed') await this.observeCommit(row, false); else await this.unchanged(row, row.finalContentKey);
      this.finish(row); return result;
    } catch (error: any) {
      if (!reserved) throw error;
      row.status = row.casCompleted ? 'uncertain' : error instanceof GitError && !error.uncertain ? 'failed' : row.casStarted || row.processTerminated === false || error instanceof GitError && error.uncertain ? 'uncertain' : 'failed'; row.error = error.message;
      this.store.transaction(() => {
        if (row.status === 'uncertain') { const current = this.store.integrationRequests().find(request => request.id === row.request.id)!; row.request = { ...current, status: 'uncertain', error: row.error }; this.store.record(current.id, workId, 'integration-request', row.request); }
        this.save(row); const intent = this.store.records(workId, 'workspace-git-intent').find(intent => intent.id === row.intentId); if (intent) this.store.record(intent.id, workId, 'workspace-git-intent', { ...intent, status: row.status, terminationUnconfirmed: row.processTerminated === false });
      });
      if (['file', 'create', 'move', 'delete'].includes(kind)) throw error;
      return row;
    } finally {
      try { if (directory && owned && row?.processTerminated !== false) try { const stat = lstatSync(directory); if (stat.dev === owned.dev && stat.ino === owned.ino && !stat.isSymbolicLink() && realpathSync(directory) === resolve(directory)) { const path = join(directory, 'paths.nul'), file = lstatSync(path); if (ownedFile && file.dev === ownedFile.dev && file.ino === ownedFile.ino && file.isFile() && !file.isSymbolicLink() && file.nlink === 1) { unlinkSync(path); rmdirSync(directory); } } } catch { /* Preserve changed private contents; lifecycle release is unconditional. */ } }
      finally {
        if (row?.processTerminated === false && row.processId) { const finish = release, pid = row.processId; const timer = setInterval(() => { try { process.kill(pid, 0); } catch (error: any) { if (error.code === 'ESRCH') { clearInterval(timer); try { finish?.(); } finally { settle(); } } } }, 1000); timer.unref(); }
        else { try { release?.(); } finally { settle(); } }
      }
    }
  }
}
