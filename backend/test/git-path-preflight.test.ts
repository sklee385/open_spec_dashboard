import { afterEach, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightGitDirectoryPath } from '../src/work/git-path-preflight';

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});
afterEach(() => { vi.mocked(childProcess.execFileSync).mockReset(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const absentPath = () => join(tmpdir(), `gp-check-${randomUUID()}`);
const failure = (stderr: string, extra = {}) => Object.assign(new Error('fixture diagnostic'), { status: 128, stderr: Buffer.from(stderr), ...extra });

it('짧은 미생성 경로는 저장소 부재로 구분하고 파일을 만들지 않는다', () => {
  const path = absentPath();
  expect(preflightGitDirectoryPath(path)).toEqual({ state: 'git-directory-absent' });
  expect(existsSync(path)).toBe(false);
});
it('짧은 한글 경로도 미생성으로 구분한다', () => {
  const path = join(tmpdir(), `가-${randomUUID()}`);
  expect(preflightGitDirectoryPath(path)).toEqual({ state: 'git-directory-absent' });
  expect(existsSync(path)).toBe(false);
});
it.skipIf(process.platform !== 'win32')('실제 Git에서 같은 글자 수의 ASCII 경로와 한글 바이트 길이 제한을 구분한다', () => {
  const prefix = `gp-${randomUUID()}-`;
  const ascii = join(tmpdir(), prefix + 'a'.repeat(65)), korean = join(tmpdir(), prefix + '가'.repeat(65));
  expect(ascii.length).toBe(korean.length);
  expect(Buffer.byteLength(korean)).toBeGreaterThan(Buffer.byteLength(ascii));
  expect(preflightGitDirectoryPath(ascii)).toEqual({ state: 'git-directory-absent' });
  expect(() => preflightGitDirectoryPath(korean)).toThrow(/짧은.*루트/);
  expect(existsSync(ascii)).toBe(false); expect(existsSync(korean)).toBe(false);
});
it('자식 환경만 영문 진단으로 고정하고 기존 Git 환경 보호와 실행 한도를 유지한다', () => {
  vi.stubEnv('GIT_DIR', 'foreign'); vi.stubEnv('GIT_INDEX_FILE', 'foreign'); vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare'); vi.stubEnv('GIT_CONFIG_VALUE_0', 'true'); vi.stubEnv('LC_ALL', 'ko_KR'); vi.stubEnv('LANG', 'ko_KR');
  const spawn = vi.mocked(childProcess.execFileSync);
  const path = absentPath();
  expect(preflightGitDirectoryPath(path)).toEqual({ state: 'git-directory-absent' });
  expect(spawn).toHaveBeenCalledWith('git', ['--no-optional-locks', '--literal-pathspecs', `--git-dir=${join(path, '.git')}`, 'rev-parse', '--git-dir'], expect.objectContaining({ shell: false, windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024 }));
  const options = spawn.mock.calls[0][2] as childProcess.ExecFileSyncOptions;
  expect(options.env).toMatchObject({ LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' });
  for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) expect(options.env).not.toHaveProperty(key);
  expect(process.env.LC_ALL).toBe('ko_KR'); expect(process.env.LANG).toBe('ko_KR'); expect(process.env.GIT_DIR).toBe('foreign');
});
it.each([
  ['spawn 실패', failure('', { code: 'ENOENT', status: null })],
  ['timeout', failure("fatal: '$GIT_DIR' too big", { code: 'ETIMEDOUT', signal: 'SIGTERM' })],
  ['출력 상한', failure("fatal: '$GIT_DIR' too big", { code: 'ENOBUFS' })],
  ['알 수 없는 stderr', failure('fatal: permission denied')],
  ['다른 상태 코드', failure("fatal: '$GIT_DIR' too big", { status: 1 })],
  ['추가 진단', failure("warning: unknown\nfatal: '$GIT_DIR' too big")],
])('%s는 경로 미지원이나 저장소 부재로 오인하지 않고 차단한다', (_name, error) => {
  vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw error; });
  try { preflightGitDirectoryPath(absentPath()); expect.fail('unexpected pass'); }
  catch (rejected: any) { expect(rejected.getResponse()).toMatchObject({ errorCode: 'workspace-git-path-check-failed' }); }
});
it('다른 경로에 대한 저장소 부재 진단은 현재 경로 점검 통과로 간주하지 않는다', () => {
  vi.mocked(childProcess.execFileSync).mockImplementation(() => { throw failure("fatal: not a git repository: 'foreign'"); });
  expect(() => preflightGitDirectoryPath(absentPath())).toThrow(/점검 결과/);
});
it('정확한 경로의 읽기 결과만 구분하고 예상하지 못한 성공 출력도 차단한다', () => {
  const path = absentPath(), spawn = vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.from(`${join(path, '.git')}\n`));
  expect(preflightGitDirectoryPath(path)).toEqual({ state: 'git-directory-readable' });
  spawn.mockReturnValue(Buffer.from('unrelated output'));
  expect(() => preflightGitDirectoryPath(path)).toThrow(/점검 결과/);
});
