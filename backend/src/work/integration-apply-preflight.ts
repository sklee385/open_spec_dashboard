import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { IntegrationVerification } from './integration-verification';
import { IntegrationEditing } from './integration-editing';
import { assertCandidateProgress, candidateBranch, candidateLocation, verifyCandidateRegistration } from './integration-candidate';
import { inspectWorkspacePath } from './workspace-paths';
import { assertWorktreePointer } from './worktree-registration';
import { projectCoordinator } from '../projects/coordinator';
import { readGitBufferSync, readGitSync, runGit } from '../projects/git-runner';
import { resolveGitRef } from '../projects/git-metadata';
import type { OperationRequest } from '../projects/operation-locks';
import { WorkStore, type IntegrationRequest } from './store';
import { WorkService } from './work.service';
import { WorkspaceSettingsService } from './workspace-settings.service';
import { WorkspaceService } from './workspace.service';
import { readCleanTrackedFiles, readGitTextAttributes, parseGitCachedSizes, type CleanFilePolicy } from './git-clean-files';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const parseListing = (text: string) => text.split('\0\0').filter(Boolean).map(group => Object.fromEntries(group.split('\0').filter(Boolean).map(field => {
  const at = field.indexOf(' '); return at < 0 ? [field, true] : [field.slice(0, at), field.slice(at + 1)];
})));

/** Read-only final checks. This service neither reserves an apply intent nor applies Git changes. */
@Injectable()
export class IntegrationApplyPreflight {
  constructor(@Inject(WorkStore) private store: WorkStore, @Inject(IntegrationVerification) private verification: IntegrationVerification,
    @Inject(IntegrationEditing) private editing: IntegrationEditing, @Inject(WorkService) private works: WorkService,
    @Inject(WorkspaceSettingsService) private settings: WorkspaceSettingsService) {}
  private read(root: string, args: string[]) { return runGit(root, ['-c', 'core.fsmonitor=false', ...args]).then(value => value.toString()).catch(() => { throw new ConflictException('원본 Git 상태를 확인할 수 없습니다'); }); }
  private plan(request: IntegrationRequest, workBranch: string): OperationRequest {
    return { kind: 'integration', root: request.projectPath, commonDir: request.commonDir, spaces: [request.workExecutionPath, request.executionPath], refs: [`refs/heads/${request.targetBranch}`, `refs/heads/${workBranch}`, `refs/heads/${candidateBranch(request)}`] };
  }
  private file(path: string) {
    if (!existsSync(path)) return null;
    inspectWorkspacePath(dirname(path), []); const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new ConflictException('원본 Git 파일 소유 경계 또는 검사 한도를 확인해 주세요');
    const descriptor = openSync(path, 'r'); let contents: Buffer;
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || opened.size > 16 * 1024 * 1024) throw new ConflictException('원본 Git 파일 소유가 변경되었습니다');
      contents = Buffer.alloc(stat.size); let offset = 0;
      while (offset < contents.length) { const count = readSync(descriptor, contents, offset, contents.length - offset, null); if (!count) throw new ConflictException('원본 Git 파일 크기가 변경되었습니다'); offset += count; }
      const finished = fstatSync(descriptor);
      if (finished.size !== stat.size || finished.mtimeMs !== stat.mtimeMs || finished.ctimeMs !== stat.ctimeMs || finished.nlink !== 1) throw new ConflictException('원본 Git 파일이 검사 중 변경되었습니다');
    } finally { closeSync(descriptor); }
    const after = lstatSync(path);
    if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mode !== stat.mode || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.nlink !== 1) throw new ConflictException('원본 Git 파일이 검사 중 교체되었습니다');
    return [stat.dev, stat.ino, stat.mode, hash(contents.toString('base64'))];
  }
  private gitDirectory(root: string, commonDir: string) {
    inspectWorkspacePath(root, []);
    if (!same(realpathSync(root), root)) throw new ConflictException('원본 실제 경로가 변경되었습니다');
    const pointer = join(root, '.git'), stat = lstatSync(pointer);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (!same(pointer, commonDir)) throw new ConflictException('원본 Git 공통 경계가 변경되었습니다');
      inspectWorkspacePath(pointer, []); return pointer;
    }
    assertWorktreePointer(root, commonDir);
    return realpathSync(resolve(root, readFileSync(pointer, 'utf8').trim().slice(8)));
  }
  private metadata(request: IntegrationRequest) {
    const roots = [request.projectPath, request.workExecutionPath, request.executionPath];
    const dirs = roots.map(root => this.gitDirectory(root, request.commonDir));
    const refs = [request.targetBranch, candidateBranch(request)].map(branch => `refs/heads/${branch}`);
    for (const directory of dirs) {
      assertCandidateProgress(request.projectPath, undefined, false, directory);
      for (const name of ['index.lock', 'HEAD.lock', 'config.lock', 'config.worktree.lock', 'shallow.lock', 'MERGE_HEAD.lock', 'AUTO_MERGE.lock']) if (existsSync(join(directory, name))) throw new ConflictException('영향 공간의 Git lock을 먼저 확인해 주세요');
    }
    for (const name of ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock', 'shallow.lock', 'worktrees.lock']) if (existsSync(join(request.commonDir, name))) throw new ConflictException('공유 Git lock을 먼저 확인해 주세요');
    const metadata = roots.map((root, index) => {
      const directory = dirs[index], head = readFileSync(join(directory, 'HEAD'), 'utf8').trim();
      if (head.startsWith('ref: ')) refs.push(head.slice(5));
      return [root, lstatSync(root).dev, lstatSync(root).ino, lstatSync(join(root, '.git')).isFile() ? this.file(join(root, '.git')) : null,
        ['HEAD', 'index', 'gitdir', 'commondir', 'config', 'config.worktree', 'locked', 'prunable'].map(name => [name, this.file(join(directory, name))])];
    });
    const related = [...new Set(refs.flatMap(ref => [ref, resolveGitRef(request.projectPath, ref)]))].sort();
    for (const ref of related) if (existsSync(join(request.commonDir, `${ref}.lock`))) throw new ConflictException('관련 Git ref lock을 먼저 확인해 주세요');
    const packed = join(request.commonDir, 'packed-refs'); this.file(packed);
    return [metadata, related.map(ref => [ref, this.file(join(request.commonDir, ref))]), existsSync(packed) ? readFileSync(packed, 'utf8').split('\n').filter(line => related.includes(line.trim().split(' ')[1])) : [],
      ['config', 'info/attributes', 'info/exclude'].map(name => [name, this.file(join(request.commonDir, name))])];
  }
  /** Hash every tracked original file, including resources excluded from candidate execution snapshots. */
  private originalFiles(root: string, tracked: string[], policy?: CleanFilePolicy) { return readCleanTrackedFiles(root, tracked, policy); }
  private attributes(root: string, tracked: string[], source?: string) { return readGitTextAttributes(root, tracked, source); }
  private cachedSizes(debug: string) { return parseGitCachedSizes(debug); }
  private async original(request: IntegrationRequest) {
    const root = request.projectPath;
    await this.editing.assertRootGitRead(root);
    const configValue = (key: string, bool = false) => runGit(root, ['-c', 'core.fsmonitor=false', 'config', ...(bool ? ['--bool'] : []), '--get', key], {}, true).then(value => value.toString().trim());
    const [branch, head, target, untracked, flags, index, listing, config, trackedText, tree, format, autocrlf, filemode, debug] = await Promise.all([
      this.read(root, ['symbolic-ref', '--quiet', 'HEAD']), this.read(root, ['rev-parse', '--verify', 'HEAD^{commit}']),
      this.read(root, ['rev-parse', '--verify', `refs/heads/${request.targetBranch}^{commit}`]),
      this.read(root, ['ls-files', '--others', '--exclude-standard', '-z']), this.read(root, ['ls-files', '-v', '-z']),
      this.read(root, ['ls-files', '--stage', '-z']), this.read(root, ['worktree', 'list', '--porcelain', '-z']),
      this.read(root, ['config', '--list', '--show-origin', '-z']), this.read(root, ['ls-files', '--cached', '-z']),
      this.read(root, ['ls-tree', '-r', '-z', request.targetHead]), this.read(root, ['rev-parse', '--show-object-format']), configValue('core.autocrlf'), configValue('core.filemode', true),
      this.read(root, ['ls-files', '--debug', '-z']),
    ]);
    if (branch.trim() !== `refs/heads/${request.targetBranch}` || head.trim() !== request.targetHead || target.trim() !== request.targetHead) throw new ConflictException('원본 대상 브랜치 또는 HEAD가 변경되었습니다');
    const entries = index.split('\0').filter(Boolean), headEntries = tree.split('\0').filter(Boolean).map(row => { const at = row.indexOf('\t'), [mode, , blob] = row.slice(0, at).split(' '); return `${mode} ${blob} 0\t${row.slice(at + 1)}`; });
    if (untracked || flags.split('\0').filter(Boolean).some(row => row[0] === 'S' || /[a-z]/.test(row[0])) || entries.some(row => !/^\d+ [a-f0-9]+ 0\t/.test(row)) || hash([...entries].sort()) !== hash(headEntries.sort())) throw new ConflictException('원본 전체 index·파일·untracked 또는 숨김 상태를 먼저 정리해 주세요');
    const rows = parseListing(listing), own = rows.filter(row => typeof row.worktree === 'string' && same(row.worktree, root));
    if (own.length !== 1 || own[0].branch !== branch.trim() || own[0].HEAD !== head.trim() || own[0].locked || own[0].prunable || rows.some(row => row.branch === branch.trim() && (typeof row.worktree !== 'string' || !same(row.worktree, root)))) throw new ConflictException('원본 등록 또는 다른 worktree의 대상 checkout을 확인해 주세요');
    // Freeze registration topology, not unrelated worktree HEADs.
    const registrations = rows.map(({ HEAD, ...row }) => row).sort((a, b) => String(a.worktree).localeCompare(String(b.worktree)));
    const tracked = [...new Set(trackedText.split('\0').filter(Boolean))].sort();
    const attributes = this.attributes(root, tracked), attributesVersion = attributes.version;
    if (!['sha1', 'sha256'].includes(format.trim())) throw new ConflictException('원본 Git object 형식을 지원하지 않습니다');
    const parsed = new Map(entries.map(row => { const at = row.indexOf('\t'), [mode, blob] = row.slice(0, at).split(' '); return [row.slice(at + 1), { mode, blob }]; }));
    const files = this.originalFiles(root, tracked, { format: format.trim(), autocrlf, filemode, attributes: attributes.attributes, index: parsed, cachedSizes: this.cachedSizes(debug) });
    return { version: hash([branch, head, target, untracked, flags, index, registrations, config, files, attributesVersion]), tracked, files, registrations, config, attributesVersion };
  }
  /** Internal ephemeral proof; callers must recapture immediately before their own ff-only write. */
  async capture(workId: string, candidateId: string) {
    const proof = await this.verification.captureReadyProof(workId, candidateId), request = proof.request;
    const plan = this.plan(request, proof.work.workspace!.branch!);
    projectCoordinator(this.store).assertOperationCanStart(plan);
    const start = this.metadata(request), original = await this.original(request), middle = this.metadata(request);
    if (hash(start) !== hash(middle)) throw new ConflictException('원본 사전검사 중 Git 기준이 변경되었습니다');
    const confirmed = await this.original(request);
    const assertUnchanged = () => {
      proof.assertUnchanged();
      // ls-files does not run clean filters. Bound stdout via readGitSync and reject
      // new untracked resources even when execution snapshots intentionally exclude them.
      if (readGitSync(request.projectPath, ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'])) throw new ConflictException('원본 미추적 파일이 변경되었습니다');
      if (this.attributes(request.projectPath, original.tracked).version !== original.attributesVersion) throw new ConflictException('원본 실제 속성이 변경되었습니다');
      const registrations = parseListing(readGitSync(request.projectPath, ['worktree', 'list', '--porcelain', '-z'])).map(({ HEAD, ...row }) => row).sort((a, b) => String(a.worktree).localeCompare(String(b.worktree)));
      if (hash(registrations) !== hash(original.registrations)) throw new ConflictException('원본 worktree 등록이 변경되었습니다');
      if (hash(this.metadata(request)) !== hash(start) || hash(this.originalFiles(request.projectPath, original.tracked)) !== hash(original.files) || readGitSync(request.projectPath, ['-c', 'core.fsmonitor=false', 'config', '--list', '--show-origin', '-z']) !== original.config) throw new ConflictException('원본 사전검사 기준이 변경되었습니다');
    };
    if (confirmed.version !== original.version) throw new ConflictException('원본 사전검사 중 파일·등록 기준이 변경되었습니다');
    assertUnchanged(); projectCoordinator(this.store).assertOperationCanStart(plan);
    const expectedVersion = hash([proof.version, proof.recordsVersion, original.version, start]);
    return { request, plan, expectedVersion, verificationRefs: proof.verificationRefs, sourceGitDir: this.gitDirectory(request.projectPath, request.commonDir), assertUnchanged };
  }
  /** Post-command observation; does not reuse a proof whose original HEAD intentionally changed. */
  captureMetadata(request: IntegrationRequest) {
    const version = hash(this.metadata(request));
    return { assertUnchanged: () => { if (hash(this.metadata(request)) !== version) throw new ConflictException('실제 관측 중 Git HEAD·index·진행 기준이 변경되었습니다'); } };
  }
  async inspectOriginal(request: IntegrationRequest, expectedHead: string) {
    const expected = { ...request, targetHead: expectedHead }, before = this.metadata(expected);
    const first = await this.original(expected), second = await this.original(expected);
    if (first.version !== second.version || hash(before) !== hash(this.metadata(expected))) throw new ConflictException('반영 뒤 원본 상태가 수집 중 변경되었습니다');
    const assertUnchanged = () => {
      const registrations = parseListing(readGitSync(expected.projectPath, ['-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain', '-z'])).map(({ HEAD, ...row }) => row).sort((a, b) => String(a.worktree).localeCompare(String(b.worktree)));
      if (hash(registrations) !== hash(first.registrations)) throw new ConflictException('원본 실제 관측 뒤 worktree 등록이 변경되었습니다');
      if (hash(before) !== hash(this.metadata(expected)) || hash(this.originalFiles(expected.projectPath, first.tracked)) !== hash(first.files) || this.attributes(expected.projectPath, first.tracked).version !== first.attributesVersion || readGitSync(expected.projectPath, ['-c', 'core.fsmonitor=false', 'config', '--list', '--show-origin', '-z']) !== first.config || readGitSync(expected.projectPath, ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard', '-z'])) throw new ConflictException('원본 실제 상태 확인 뒤 파일·Git 기준이 변경되었습니다');
    };
    assertUnchanged();
    return { head: expectedHead, version: first.version, assertUnchanged };
  }
  /** Historical/applying/queued access without pretending the candidate is ready to apply. */
  inspectOwnership(workId: string, candidateId: string, queued = false) {
    const work = this.works.get(workId), request = this.store.integrationRequests().find(row => row.workId === workId && row.candidateId === candidateId);
    if (!request || request.projectPath !== work.projectPath || request.workspaceId !== work.workspace?.workspaceId || request.workExecutionPath !== work.executionPath || request.commonDir !== work.workspace?.commonDir || request.projectId !== work.workspace?.projectId) throw new ConflictException('후보의 저장된 업무 소유가 변경되었습니다');
    const source = this.works.legacy.sources().find(row => row.id === work.sourceId && row.valid);
    if (!source || !same(realpathSync(dirname(source.path)), request.projectPath)) throw new ConflictException('고정 원본 프로젝트 등록이 변경되었습니다');
    new WorkspaceService(this.store, { protectedPaths: () => this.settings.protectedPaths() }).path(work);
    const location = candidateLocation(request, this.settings.protectedPaths());
    if (queued && request.status === 'queued') {
      if (existsSync(location.container) || readGitSync(request.projectPath, ['-c', 'core.fsmonitor=false', 'for-each-ref', '--format=%(refname)', `refs/heads/${location.branch}`]).trim()) throw new ConflictException('예약 밖 후보 잔여물의 소유를 먼저 확인해 주세요');
    } else {
      const registration = verifyCandidateRegistration(request, this.settings.protectedPaths());
      if (registration.head !== (request.status === 'conflicted' ? request.targetHead : request.candidateCommit)) throw new ConflictException('후보 commit 소유가 변경되었습니다');
    }
    return { work, request, plan: this.plan(request, work.workspace!.branch!) };
  }
  /** Checkout evaluates new paths in the original's config/info/global attribute context. */
  async captureSourceAttributes(request: IntegrationRequest) {
    if (!request.candidateCommit) throw new ConflictException('고정 후보 커밋이 없습니다');
    const paths = (await this.read(request.projectPath, ['ls-tree', '-r', '--name-only', '-z', request.candidateCommit])).split('\0').filter(Boolean).sort();
    if (paths.length > 10000) throw new ConflictException('후보 전체 경로 속성 검사 한도를 초과했습니다');
    const read = () => hash([paths, this.attributes(request.projectPath, paths).version, this.attributes(request.projectPath, paths, request.candidateCommit!).version]);
    const version = read();
    return { version, assertUnchanged: () => { if (read() !== version) throw new ConflictException('원본의 후보 전체 경로 속성이 변경되었습니다'); } };
  }
  async preview(workId: string, candidateId: string) {
    const proof = await this.capture(workId, candidateId);
    return { candidateId, preflightPassed: true, applied: false, expectedVersion: proof.expectedVersion };
  }
  async confirm(workId: string, candidateId: string, body: any) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['confirmed', 'expectedVersion'].includes(key)) || body.confirmed !== true || typeof body.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedVersion)) throw new BadRequestException('명시 확인과 사전검사 버전을 지정해 주세요');
    const proof = await this.capture(workId, candidateId);
    if (body.expectedVersion !== proof.expectedVersion) throw new ConflictException('사전검사 버전이 변경되었습니다. 다시 확인해 주세요');
    proof.assertUnchanged();
    return { candidateId, preflightPassed: true, applied: false, expectedVersion: proof.expectedVersion };
  }
}
