import { ConflictException } from '@nestjs/common';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { IntegrationRequest } from './store';
import { readWorkspaceRoot } from './workspace-root';
import { inspectWorkspacePath } from './workspace-paths';
import { assertWorktreePointer } from './worktree-registration';
import { readGitSync, runGit } from '../projects/git-runner';

const same = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
export const candidateBranch = (request: IntegrationRequest) => `codex/integration-${request.candidateId}`;
export type CandidateAutoMergeEvidence = { autoMergeCaptured?: boolean; autoMerge?: string | null };
/** Read the candidate's worktree-local pseudoref without adopting or deleting it. */
export function candidateAutoMerge(root: string, validatedGitDir?: string): string | null {
  let gitDir = validatedGitDir;
  if (!gitDir) {
    const pointerPath = join(root, '.git'), stat = lstatSync(pointerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new ConflictException('후보 Git 포인터 소유가 다릅니다');
    const pointer = readFileSync(pointerPath, 'utf8').trim();
    if (!pointer.startsWith('gitdir: ')) throw new ConflictException('후보 Git 포인터가 변경되었습니다');
    gitDir = resolve(root, pointer.slice(8)); inspectWorkspacePath(gitDir, []);
  }
  const path = join(gitDir, 'AUTO_MERGE'); if (!existsSync(path)) return null;
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256) throw new ConflictException('후보 AUTO_MERGE의 소유가 다릅니다');
  const value = readFileSync(path, 'utf8').trim(), after = lstatSync(path);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) || after.isSymbolicLink() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ConflictException('후보 AUTO_MERGE를 읽는 중 변경되었습니다');
  return value;
}
export function assertCandidateAutoMerge(root: string, evidence: CandidateAutoMergeEvidence, consumed = false, validatedGitDir?: string) {
  if (evidence.autoMergeCaptured !== true || evidence.autoMerge !== null && (typeof evidence.autoMerge !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.autoMerge))) throw new ConflictException('원래 후보 AUTO_MERGE의 소유 근거가 없습니다. 추정하여 정리하지 않습니다');
  if (candidateAutoMerge(root, validatedGitDir) !== (consumed ? null : evidence.autoMerge)) throw new ConflictException('후보 AUTO_MERGE가 외부에서 변경되었습니다. 복구 ref를 보존합니다');
}
/** Inspect progress without consuming or deleting any foreign Git metadata. */
export function assertCandidateProgress(root: string, ownedMergeHead?: string, allowMissingMerge = false, validatedGitDir?: string) {
  const gitDir = validatedGitDir ?? realpathSync(readGitSync(root, ['rev-parse', '--absolute-git-dir']).trim());
  if (['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'sequencer', 'rebase-merge', 'rebase-apply', 'MERGE_AUTOSTASH'].some(name => existsSync(join(gitDir, name)))) throw new ConflictException('후보에 다른 Git 진행 표시가 있습니다. 소유 검증 없이 정리하지 않습니다');
  const hasMerge = existsSync(join(gitDir, 'MERGE_HEAD'));
  if (hasMerge ? !ownedMergeHead || (validatedGitDir ? readFileSync(join(gitDir, 'MERGE_HEAD'), 'utf8').trim() : readGitSync(root, ['rev-parse', '--verify', 'MERGE_HEAD']).trim()) !== ownedMergeHead : !!ownedMergeHead && !allowMissingMerge) throw new ConflictException('후보의 소유 MERGE_HEAD가 다릅니다');
  if (!hasMerge && existsSync(join(gitDir, 'AUTO_MERGE'))) throw new ConflictException('소유 병합이 없는 AUTO_MERGE 표시를 확인해 주세요');
  return hasMerge ? ownedMergeHead! : null;
}

/** Candidate editing's final checkpoint: independent read-only Git commands never block the event loop. */
export async function verifyCandidateCheckpoint(request: IntegrationRequest, protectedPaths: string[], expectedHead: string, ownedMergeHead?: string, allowMissingMerge = false, expectedIndex?: string) {
  const location = candidateLocation(request, protectedPaths);
  const fsOwner = () => {
    candidateLocation(request, protectedPaths); assertWorktreePointer(location.path, request.commonDir);
    const stat = lstatSync(location.path), identityPath = join(location.container, 'identity.json'), identityStat = lstatSync(identityPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(realpathSync(location.path), location.path) || !identityStat.isFile() || identityStat.isSymbolicLink() || identityStat.nlink !== 1 || identityStat.size > 65536) throw new ConflictException('후보 checkpoint 소유가 변경되었습니다');
    const identity = readFileSync(identityPath, 'utf8'), parsed = JSON.parse(identity);
    if (Object.entries(candidateIdentity(request)).some(([key, value]) => parsed[key] !== value)) throw new ConflictException('후보 identity가 변경되었습니다');
    const pointer = readFileSync(join(location.path, '.git'), 'utf8').trim(), gitDir = realpathSync(resolve(location.path, pointer.slice(8)));
    const refs = [join(gitDir, 'HEAD'), join(gitDir, 'index'), join(request.commonDir, 'refs', 'heads', location.branch), join(request.commonDir, 'packed-refs')].map(path => {
      if (!existsSync(path)) return [path, null];
      const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new ConflictException('후보 checkpoint ref 소유가 변경되었습니다');
      if (path === join(request.commonDir, 'packed-refs')) return [path, readFileSync(path, 'utf8').split('\n').filter(line => line.trim().split(' ')[1] === `refs/heads/${location.branch}`)];
      return [path, stat.dev, stat.ino, readFileSync(path).toString('base64')];
    });
    return { stamp: JSON.stringify([stat.dev, stat.ino, identityStat.dev, identityStat.ino, identity, pointer, gitDir, refs]), gitDir };
  };
  const before = fsOwner(), read = async (root: string, args: string[]) => (await runGit(root, ['-c', 'core.fsmonitor=false', ...args])).toString().trim();
  const [sourceTop, sourceCommon, ownTop, ownCommon, head, branch, listing, index] = await Promise.all([
    read(request.projectPath, ['rev-parse', '--show-toplevel']), read(request.projectPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    read(location.path, ['rev-parse', '--show-toplevel']), read(location.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    read(location.path, ['rev-parse', '--verify', 'HEAD^{commit}']), read(location.path, ['symbolic-ref', 'HEAD']), read(request.projectPath, ['worktree', 'list', '--porcelain', '-z']),
    runGit(location.path, ['-c', 'core.fsmonitor=false', 'ls-files', '--stage', '-z']).then(value => value.toString()),
  ]);
  const registrations = listing.split('\0\0').map(group => Object.fromEntries(group.split('\0').filter(Boolean).map(field => { const at = field.indexOf(' '); return at < 0 ? [field, true] : [field.slice(0, at), field.slice(at + 1)]; })));
  const own = registrations.filter(row => typeof row.worktree === 'string' && same(row.worktree, location.path));
  if (fsOwner().stamp !== before.stamp || expectedIndex !== undefined && index !== expectedIndex || !same(realpathSync(sourceTop), request.projectPath) || !same(realpathSync(sourceCommon), request.commonDir) || !same(realpathSync(ownTop), location.path) || !same(realpathSync(ownCommon), request.commonDir) || head !== expectedHead || own.length !== 1 || own[0].locked || own[0].prunable || own[0].branch !== `refs/heads/${location.branch}` || branch !== own[0].branch || own[0].HEAD !== head) throw new ConflictException('후보 checkpoint 등록·HEAD·브랜치가 변경되었습니다');
  assertCandidateProgress(location.path, ownedMergeHead, allowMissingMerge, before.gitDir);
  return { ...location, head, gitDir: before.gitDir };
}
/** Candidate identity is deliberately independent of WorkWorkspace and codex/work branches. */
export function candidateLocation(request: IntegrationRequest, protectedPaths: string[]) {
  const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  if (request.version !== 1 || !uuid(request.candidateId) || !uuid(request.profileId) || !uuid(request.rootId) || !/^[a-f0-9]{64}$/.test(request.projectId) || !isAbsolute(request.rootPath)) throw new ConflictException('후보 식별 정보를 확인할 수 없습니다.');
  const root = readWorkspaceRoot(request.rootPath, [...protectedPaths, request.projectPath], request.profileId);
  const container = join(root.managedPath, 'projects', request.projectId, 'integrations', request.candidateId), path = join(container, 'project');
  if (root.rootId !== request.rootId || root.managedPath !== request.managedPath || request.executionPath !== path || same(path, request.workExecutionPath)) throw new ConflictException('후보의 고정 경로가 달라졌습니다.');
  inspectWorkspacePath(path, [...protectedPaths, request.projectPath, request.workExecutionPath]);
  return { container, path, branch: candidateBranch(request) };
}
export function candidateIdentity(request: IntegrationRequest) {
  return { schemaVersion: 1, kind: 'integration-candidate', integrationId: request.id, workId: request.workId, candidateId: request.candidateId, projectPath: request.projectPath, profileId: request.profileId, rootId: request.rootId, projectId: request.projectId, executionPath: request.executionPath, commonDir: request.commonDir, branch: candidateBranch(request), targetHead: request.targetHead, resultCommit: request.resultCommit };
}
/** Used on every candidate access; caller additionally authorizes project/work/candidate relationships. */
export function verifyCandidateRegistration(request: IntegrationRequest, protectedPaths: string[]) {
  const location = candidateLocation(request, protectedPaths), stat = lstatSync(location.path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !same(realpathSync(location.path), location.path)) throw new ConflictException('후보 실제 디렉터리의 소유가 다릅니다.');
  const identityPath = join(location.container, 'identity.json'), identityStat = lstatSync(identityPath);
  if (!identityStat.isFile() || identityStat.isSymbolicLink() || identityStat.nlink !== 1 || identityStat.size > 65536) throw new ConflictException('후보 identity의 소유가 다릅니다.');
  const identity = JSON.parse(readFileSync(identityPath, 'utf8')), expected = candidateIdentity(request);
  if (Object.entries(expected).some(([key, value]) => identity[key] !== value)) throw new ConflictException('후보 identity가 변경되었습니다.');
  assertWorktreePointer(location.path, request.commonDir);
  const git = (root: string, args: string[]) => readGitSync(root, args).trim();
  for (const root of [request.projectPath, location.path]) {
    if (!same(realpathSync(git(root, ['rev-parse', '--show-toplevel'])), root) || !same(realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])), request.commonDir)) throw new ConflictException('후보 Git 공통 경계가 변경되었습니다.');
  }
  const registrations = readGitSync(request.projectPath, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').map(group => Object.fromEntries(group.split('\0').filter(Boolean).map(field => { const at = field.indexOf(' '); return at < 0 ? [field, true] : [field.slice(0, at), field.slice(at + 1)]; })));
  const own = registrations.filter(row => typeof row.worktree === 'string' && same(row.worktree, location.path));
  const head = git(location.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (own.length !== 1 || own[0].locked || own[0].prunable || own[0].branch !== `refs/heads/${location.branch}` || git(location.path, ['symbolic-ref', 'HEAD']) !== own[0].branch || own[0].HEAD !== head) throw new ConflictException('후보 worktree 등록·HEAD·브랜치가 변경되었습니다.');
  return { ...location, head };
}
