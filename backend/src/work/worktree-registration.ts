import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { readGitSync } from '../projects/git-runner';
import type { Work, WorkWorkspace } from './store';
import { inspectWorkspacePath } from './workspace-paths';
const same = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
export function assertWorktreePointer(executionPath: string, commonDir: string) {
  const readPointer = (path: string) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error('Git 포인터 소유 불일치');
    return readFileSync(path, 'utf8').trim();
  };
  const pointer = join(executionPath, '.git'), text = readPointer(pointer);
  if (!text.startsWith('gitdir: ')) throw new Error('Git 포인터 오류');
  const gitdirPath = resolve(executionPath, text.slice(8)); inspectWorkspacePath(gitdirPath, []);
  const gitdir = realpathSync(gitdirPath);
  if (!same(dirname(gitdir), join(commonDir, 'worktrees')) || !same(realpathSync(resolve(gitdir, readPointer(join(gitdir, 'gitdir')))), pointer) || !same(realpathSync(resolve(gitdir, readPointer(join(gitdir, 'commondir')))), commonDir)) throw new Error('Git 포인터 역참조 소유 경계 불일치');
}
/** Every path use checks actual registration; no cached asynchronous approval. */
export function verifyWorktreeRegistration(work: Work, space: WorkWorkspace) {
  if (space.kind !== 'git-worktree' || !space.commonDir || space.branch !== `codex/work-${work.id}` || !space.baseCommit || !space.workspaceBaselineCommit) throw new Error('Git 기준 식별 불일치');
  assertWorktreePointer(space.executionPath, space.commonDir);
  const git = (root: string, args: string[]) => readGitSync(root, args).trim();
  const sourceCommon = realpathSync(git(work.projectPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const ownCommon = realpathSync(git(space.executionPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (!same(sourceCommon, space.commonDir) || !same(ownCommon, space.commonDir)) throw new Error('Git 공통 경계 불일치');
  const listing = readGitSync(work.projectPath, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').map(group => Object.fromEntries(group.split('\0').filter(Boolean).map(field => { const index = field.indexOf(' '); return index < 0 ? [field, true] : [field.slice(0, index), field.slice(index + 1)]; })));
  const registration = listing.find(entry => typeof entry.worktree === 'string' && same(entry.worktree, space.executionPath));
  if (!registration || registration.locked || registration.prunable || registration.branch !== `refs/heads/${space.branch}` || git(space.executionPath, ['symbolic-ref', 'HEAD']) !== registration.branch || git(space.executionPath, ['rev-parse', '--verify', 'HEAD^{commit}']) !== registration.HEAD) throw new Error('Git 실제 등록 불일치');
}
