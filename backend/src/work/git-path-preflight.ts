import { ConflictException } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { gitEnvironment } from '../projects/git-runner';

export type GitDirectoryPathCheck = { state: 'git-directory-absent' | 'git-directory-readable' };

/**
 * Check Git's explicit GIT_DIR path guard before reserving a new path; never create a repository.
 * Absence is an expected diagnostic, not Git capability success. Neither result establishes
 * ownership or permits adopting/reusing a path; existing workspaces retain their separate verification.
 */
export function preflightGitDirectoryPath(executionPath: string): GitDirectoryPathCheck {
  const gitDir = join(executionPath, '.git');
  const unchecked = () => new ConflictException({ message: 'Git 경로 사전 점검 결과를 확인할 수 없습니다. 환경을 확인한 뒤 다시 시도해 주세요.', errorCode: 'workspace-git-path-check-failed' });
  let output: Buffer;
  try {
    output = execFileSync('git', ['--no-optional-locks', '--literal-pathspecs', `--git-dir=${gitDir}`, 'rev-parse', '--git-dir'], {
      shell: false, windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024,
      env: { ...gitEnvironment(), LC_ALL: 'C', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    // Spawn, timeout and output-limit failures must not be mistaken for an absent repository.
    if (error.code || error.signal || error.status !== 128 || !Buffer.isBuffer(error.stderr)) throw unchecked();
    const diagnostic = error.stderr.toString('utf8').trim();
    if (diagnostic === "fatal: '$GIT_DIR' too big") throw new ConflictException({ message: '설치된 Git이 예정 작업 공간의 경로 길이를 지원하지 않습니다. 더 짧은 작업 공간 루트를 선택해 주세요.', errorCode: 'workspace-git-path-unsupported' });
    if (diagnostic === `fatal: not a git repository: '${gitDir}'`) return { state: 'git-directory-absent' };
    throw unchecked();
  }
  if (output.toString('utf8').trim() !== gitDir) throw unchecked();
  return { state: 'git-directory-readable' };
}
