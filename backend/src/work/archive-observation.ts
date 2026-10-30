import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readGitSync } from '../projects/git-runner';
import { assertCandidateProgress } from './integration-candidate';
import { readCleanTrackedFiles, readGitTextAttributes, parseGitCachedSizes } from './git-clean-files';
import { inspectWorkspacePath } from './workspace-paths';
import { directories, markdownFiles } from '../legacy/parser';
import { within } from '../files';
import type { Work } from './store';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
export type ArchiveCheck = { state: 'clean' | 'dirty' | 'unknown' | 'not-applicable'; nextIntegrationBlocked: boolean; head?: string; branch?: string; commonDir?: string; version?: string; reason?: string };
/** No status/diff: observing archive output must never run a clean filter. */
export function inspectArchiveSource(root: string, expected?: { commonDir?: string; branch?: string; head?: string }): { observation: ArchiveCheck; assertUnchanged: () => void } {
  const read = (...args: string[]) => readGitSync(root, ['-c', 'core.fsmonitor=false', ...args]);
  let head: string | undefined, branch: string | undefined, commonDir: string | undefined;
  try {
    inspectWorkspacePath(root, []);
    if (canonical(realpathSync(root)) !== canonical(root)) throw new Error('원본 실제 경로가 변경되었습니다');
    if (!existsSync(join(root, '.git'))) {
      if (expected) throw new Error('원본 Git 경계가 없습니다');
      const stat = lstatSync(root), version = hash([root, stat.dev, stat.ino]);
      return { observation: { state: 'not-applicable', nextIntegrationBlocked: false, version }, assertUnchanged: () => { const current = lstatSync(root); if (existsSync(join(root, '.git')) || current.dev !== stat.dev || current.ino !== stat.ino) throw new ConflictException('보관 원본 경계가 변경되었습니다'); } };
    }
    const pointer = lstatSync(join(root, '.git'));
    if (pointer.isSymbolicLink() || pointer.isFile() && pointer.nlink !== 1) throw new Error('원본 Git 소유를 확인할 수 없습니다');
    const top = read('rev-parse', '--show-toplevel').trim(), gitDir = read('rev-parse', '--absolute-git-dir').trim(); commonDir = read('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    if (canonical(top) !== canonical(root) || expected?.commonDir && canonical(commonDir) !== canonical(expected.commonDir)) throw new Error('원본 Git root/common-dir가 변경되었습니다');
    inspectWorkspacePath(gitDir, []); inspectWorkspacePath(commonDir, []); assertCandidateProgress(root, undefined, false, gitDir);
    for (const dir of [gitDir, commonDir]) for (const file of ['index', 'HEAD', 'config', 'config.worktree']) {
      if (existsSync(join(dir, file))) { const stat = lstatSync(join(dir, file)); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('원본 Git metadata 소유를 확인할 수 없습니다'); }
      if (existsSync(join(dir, file+'.lock'))) throw new Error('원본 Git lock을 먼저 확인해 주세요');
    }
    branch = read('symbolic-ref', '--quiet', 'HEAD').trim(); head = read('rev-parse', '--verify', 'HEAD^{commit}').trim();
    if (expected?.branch && branch !== `refs/heads/${expected.branch}` || expected?.head && head !== expected.head) throw new Error('원본 실제 branch/HEAD가 완료 근거와 다릅니다');
    const index = read('ls-files', '--stage', '-z'), tree = read('ls-tree', '-r', '-z', head), flags = read('ls-files', '-v', '-z'), untracked = read('ls-files', '--others', '--exclude-standard', '-z');
    const entries = index.split('\0').filter(Boolean), wanted = tree.split('\0').filter(Boolean).map(row => { const at = row.indexOf('\t'), [mode, , blob] = row.slice(0, at).split(' '); return `${mode} ${blob} 0\t${row.slice(at + 1)}`; });
    const config = read('config', '--list', '--show-origin', '-z'), paths = entries.map(row => row.slice(row.indexOf('\t') + 1)).sort(), attrs = readGitTextAttributes(root, paths);
    if (untracked || flags.split('\0').filter(Boolean).some(row => row[0] === 'S' || /[a-z]/.test(row[0])) || entries.some(row => !/^\d+ [a-f0-9]+ 0\t/.test(row)) || hash(entries.sort()) !== hash(wanted.sort())) return { observation: { state: 'dirty', nextIntegrationBlocked: true, head, branch, commonDir, reason: '보관 원본의 staged·unstaged·untracked 또는 숨김 상태를 확인해 주세요' }, assertUnchanged: () => { throw new ConflictException('원본 dirty 상태는 보관 확정 근거가 아닙니다'); } };
    const format = read('rev-parse', '--show-object-format').trim(); if (!['sha1', 'sha256'].includes(format)) throw new Error('Git object 형식을 지원하지 않습니다');
    let files: unknown;
    try {
      files = readCleanTrackedFiles(root, paths, { format, autocrlf: read('config', '--default=false', '--get', 'core.autocrlf').trim(), filemode: read('config', '--bool', '--default=true', '--get', 'core.filemode').trim(), attributes: attrs.attributes, cachedSizes: parseGitCachedSizes(read('ls-files', '--debug', '-z')), index: new Map(entries.map(row => { const at = row.indexOf('\t'), [mode, blob] = row.slice(0, at).split(' '); return [row.slice(at + 1), { mode, blob }]; })) });
    } catch (error: any) { return { observation: { state: 'dirty', nextIntegrationBlocked: true, head, branch, commonDir, reason: error.message }, assertUnchanged: () => { throw new ConflictException('원본 파일 변경 또는 검사 불가 상태를 먼저 확인해 주세요'); } }; }
    const version = hash([top, gitDir, commonDir, head, branch, index, flags, config, attrs.version, files]);
    return { observation: { state: 'clean', nextIntegrationBlocked: false, head, branch, commonDir, version }, assertUnchanged: () => { const again = inspectArchiveSource(root, expected).observation; if (again.state !== 'clean' || again.version !== version) throw new ConflictException('보관 확인 중 원본 Git·파일 상태가 변경되었습니다'); } };
  } catch (error: any) { return { observation: { state: 'unknown', nextIntegrationBlocked: true, ...(head ? { head } : {}), ...(branch ? { branch } : {}), ...(commonDir ? { commonDir } : {}), reason: error.message }, assertUnchanged: () => { throw new ConflictException('보관 원본의 실제 상태를 확인할 수 없습니다'); } }; }
}
export function observeArchiveMove(work: Work, source: string) {
  if (existsSync(within(source, `changes/${work.changeName}`))) return null;
  const parent = join(source, 'changes/archive'); if (existsSync(parent)) inspectWorkspacePath(parent, []);
  const names = directories(join(source, 'changes/archive')).filter(name => name === work.changeName || /^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === work.changeName);
  if (names.length !== 1) return null;
  const root = within(source, `changes/archive/${names[0]}`); inspectWorkspacePath(root, []);
  for (const dir of ['specs', 'source-ideas']) if (existsSync(join(root, dir))) inspectWorkspacePath(join(root, dir), []);
  const paths = ['.openspec.yaml', 'proposal.md', 'design.md', 'tasks.md', 'verification.md', ...['specs', 'source-ideas'].flatMap(dir => markdownFiles(join(root, dir)).map(path => `${dir}/${path}`))].filter(path => existsSync(within(root, path)));
  if (paths.length > 10000) throw new ConflictException('보관 문서 수 한도를 초과했습니다');
  if (!paths.length) return null;
  const documents = readCleanTrackedFiles(root, paths.sort());
  return { archiveName: names[0], version: hash(documents) };
}
