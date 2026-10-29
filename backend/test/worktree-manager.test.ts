import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeManager } from '../src/work/worktree-manager';
import { GitError } from '../src/projects/git-runner';
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const repo = (commit = true) => {
  const root = mkdtempSync(join(tmpdir(), 'worktree-manager-')); git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
  if (commit) { writeFileSync(join(root, 'code.txt'), 'base'); git(root, 'add', '--', 'code.txt'); git(root, 'commit', '-m', 'base'); }
  return root;
};
it('실제 HEAD와 로컬 브랜치·변경 목록을 조회하며 파일과 index를 바꾸지 않는다', async () => {
  const root = repo(); git(root, 'branch', 'feature'); writeFileSync(join(root, 'code.txt'), 'staged'); git(root, 'add', '--', 'code.txt'); writeFileSync(join(root, 'code.txt'), 'unstaged'); writeFileSync(join(root, '새 파일.txt'), 'untracked');
  const before = git(root, 'status', '--porcelain=v1'), head = git(root, 'rev-parse', 'HEAD');
  const result = await new WorktreeManager().inspect(root);
  expect(result).toMatchObject({ state: 'ready', branch: 'main', head, baseCommit: head, selectedBranch: 'main' });
  expect(result.branches.map(branch => branch.name)).toEqual(['feature', 'main']);
  expect(result.entries).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'code.txt', index: 'M', worktree: 'M' }), expect.objectContaining({ path: '새 파일.txt', untracked: true })]));
  expect(git(root, 'status', '--porcelain=v1')).toBe(before); expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
});
it('detached HEAD는 로컬 브랜치 선택을 요구하며 잘못된 선택을 거부한다', async () => {
  const root = repo(); git(root, 'checkout', '--detach', 'HEAD'); const manager = new WorktreeManager();
  expect((await manager.inspect(root)).state).toBe('branch-required');
  expect(await manager.inspect(root, 'main')).toMatchObject({ state: 'ready', branch: null, selectedBranch: 'main' });
  expect((await manager.inspect(root, '--bad')).state).toBe('branch-required');
});
it('비Git·초기 커밋 없음과 Git 실행 오류를 구분하고 오류를 copy로 바꾸지 않는다', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'plain-project-')), manager = new WorktreeManager();
  expect(await manager.inspect(plain)).toMatchObject({ state: 'not-git', copyEligible: true });
  expect(await manager.inspect(repo(false))).toMatchObject({ state: 'no-commits', copyEligible: true });
  const broken = new WorktreeManager({ run: async () => { throw new GitError('Git unavailable', 503); } });
  expect(await broken.inspect(plain)).toMatchObject({ state: 'git-error', copyEligible: false });
});
it('등록 경계가 Git 최상위와 다르거나 submodule 경계이면 생성을 차단한다', async () => {
  const root = repo(), nested = join(root, 'nested'); mkdirSync(nested);
  expect(await new WorktreeManager().inspect(nested)).toMatchObject({ state: 'boundary-mismatch', copyEligible: false });
  const child = repo(); git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'submodule');
  expect(await new WorktreeManager().inspect(root)).toMatchObject({ state: 'unsupported-boundary', copyEligible: false });
  expect(await new WorktreeManager().inspect(join(root, 'submodule'))).toMatchObject({ state: 'unsupported-boundary', copyEligible: false });
});
