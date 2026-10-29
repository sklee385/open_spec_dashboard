import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore, type Work } from '../src/work/store';
import { FileResults } from '../src/work/file-results';
import { registerWorkspaceRoot } from '../src/work/workspace-root';
import { inspectWorkspacePath } from '../src/work/workspace-paths';
import * as runner from '../src/projects/git-runner';
import { readGitBlobsSync } from '../src/projects/git-blobs';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
let store: WorkStore, work: Work, root: string, baseline: string;
const contents = new Map<string, Buffer>();
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'gb-')), source = join(dir, 's'); mkdirSync(source);
  process.env.DATA_DIR = join(dir, 'd');
  git(source, 'init', '-b', 'main'); git(source, 'config', 'core.autocrlf', 'false'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test');
  for (let i = 0; i < 100; i++) contents.set(`file-${i}.txt`, Buffer.from(`baseline ${i}\n`));
  for (const [path, value] of Object.entries({ 'empty.txt': '', 'binary.txt': 'a\0b\n', 'newline.txt': 'a\nb\n', 'crlf.txt': 'a\r\nb\r\n', 'tasks.md': '- [ ] task\r\n', 'ordinary.txt': '- [ ] task\r\n', 'mode.txt': 'mode\n', 'removed.txt': 'removed', 'large.txt': 'x'.repeat(200000) })) contents.set(path, Buffer.from(value));
  for (const [path, bytes] of contents) writeFileSync(join(source, path), bytes);
  git(source, 'add', '--all'); git(source, 'commit', '-m', 'fixture'); baseline = git(source, 'rev-parse', 'HEAD');
  const profileId = randomUUID(), rootPath = join(dir, 'r'), registered = registerWorkspaceRoot(inspectWorkspacePath(rootPath, []), [], profileId), workspaceId = randomUUID(), projectId = 'a'.repeat(64);
  const container = join(registered.managedPath, 'projects', projectId, 'works', workspaceId); root = join(container, 'project'); mkdirSync(container, { recursive: true });
  const branch = 'codex/work-a'; git(source, 'worktree', 'add', '-b', branch, root, baseline);
  work = { id: 'a', sourceId: 'demo', projectPath: source, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'verification', state: 'idle', threadId: 'fixture', reviewedVersion: null, createdAt: '', updatedAt: '', executionPath: root,
    workspace: { version: 1, kind: 'git-worktree', status: 'ready', profileId, rootId: registered.rootId, rootPath, managedPath: registered.managedPath, projectId, workspaceId, executionPath: root, commonDir: join(source, '.git'), branch, baseCommit: baseline, workspaceBaselineCommit: baseline } };
  writeFileSync(join(container, 'identity.json'), JSON.stringify({ schemaVersion: 1, workId: 'a', projectPath: source, ...work.workspace }));
  store = new WorkStore(); store.save(work);
  for (let i = 0; i < 100; i++) writeFileSync(join(root, `file-${i}.txt`), `changed ${i}\n`);
  for (const name of ['empty.txt', 'binary.txt', 'newline.txt', 'large.txt']) writeFileSync(join(root, name), `changed ${name}\n`);
  writeFileSync(join(root, 'crlf.txt'), 'a\nb\n'); writeFileSync(join(root, 'tasks.md'), '- [x] task\n');
  writeFileSync(join(root, 'ordinary.txt'), '- [x] task\n');
  unlinkSync(join(root, 'removed.txt')); writeFileSync(join(root, 'added.txt'), 'added\n'); git(root, 'update-index', '--chmod=+x', '--', 'mode.txt');
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => { store?.onApplicationShutdown(); delete process.env.DATA_DIR; });

it('실제 Git 100개 고유 blob을 한 번에 조회하고 기존 보고서 본문·해시·가용성·mode를 보존한다', () => {
  const read = vi.spyOn(runner, 'readGitBufferSync'), report = new FileResults(store).report(work);
  expect(report.source).toBe('current');
  for (let i = 0; i < 100; i++) expect(report.files.find((f: any) => f.path === `file-${i}.txt`)).toMatchObject({ before: `baseline ${i}\n`, after: `changed ${i}\n`, beforeHash: digest(`baseline ${i}\n`), afterHash: digest(`changed ${i}\n`), beforeAvailability: 'text', afterAvailability: 'text', beforeMode: '100644', afterMode: '100644' });
  expect(report.files.find((f: any) => f.path === 'empty.txt')).toMatchObject({ before: '', beforeHash: digest(''), beforeAvailability: 'text' });
  expect(report.files.find((f: any) => f.path === 'binary.txt')).toMatchObject({ before: null, beforeHash: digest(contents.get('binary.txt')!), beforeAvailability: 'binary' });
  expect(report.files.find((f: any) => f.path === 'newline.txt')).toMatchObject({ before: 'a\nb\n' });
  expect(report.files.find((f: any) => f.path === 'large.txt')).toMatchObject({ before: null, beforeHash: `git:${git(root, 'rev-parse', `${baseline}:large.txt`)}`, beforeAvailability: 'size-limit' });
  expect(report.files.find((f: any) => f.path === 'removed.txt')).toMatchObject({ before: 'removed', after: null, afterAvailability: 'absent', status: 'removed' });
  expect(report.files.find((f: any) => f.path === 'added.txt')).toMatchObject({ before: null, beforeAvailability: 'absent', after: 'added\n', status: 'added' });
  expect(report.files.find((f: any) => f.path === 'mode.txt')).toMatchObject({ before: 'mode\n', after: 'mode\n', beforeMode: '100644', afterMode: '100755' });
  expect(report.files.some((f: any) => ['crlf.txt', 'tasks.md'].includes(f.path))).toBe(false);
  expect(report.files.find((f: any) => f.path === 'ordinary.txt')).toMatchObject({ before: '- [ ] task\r\n', after: '- [x] task\n', beforeHash: digest('- [ ] task\r\n') });
  const calls = read.mock.calls.filter(([, args]) => args[0] === 'cat-file');
  expect(calls).toHaveLength(1); expect(calls[0][1]).toEqual(['cat-file', '--batch']);
});

it('blob 조회 후 소스가 바뀌면 변경 보고서를 공개하지 않는다', () => {
  const read = runner.readGitBufferSync;
  vi.spyOn(runner, 'readGitBufferSync').mockImplementation((...args) => { const bytes = read(...args); if (args[1][0] === 'cat-file') writeFileSync(join(root, 'file-0.txt'), 'race\n'); return bytes; });
  try { expect(new FileResults(store).report(work)).toMatchObject({ source: 'unavailable', error: expect.stringContaining('수집 중') }); }
  finally { writeFileSync(join(root, 'file-0.txt'), 'changed 0\n'); }
});

it('실제 Git의 없는 객체와 blob이 아닌 객체를 본문으로 받아들이지 않는다', () => {
  expect(() => readGitBlobsSync(root, [{ blob: '0'.repeat(40), size: 0 }], () => null)).toThrow(/Git/);
  expect(() => readGitBlobsSync(root, [{ blob: baseline, size: 0 }], () => null)).toThrow(/Git/);
});

it('tasks 본문이 바뀔 때 원래 CRLF·체크박스 본문과 원시 해시를 그대로 표시한다', () => {
  writeFileSync(join(root, 'tasks.md'), '- [x] task changed\n');
  try {
    const file = new FileResults(store).report(work).files.find((f: any) => f.path === 'tasks.md');
    expect(file).toMatchObject({ before: '- [ ] task\r\n', after: '- [x] task changed\n', beforeHash: digest('- [ ] task\r\n'), afterHash: digest('- [x] task changed\n') });
  } finally { writeFileSync(join(root, 'tasks.md'), '- [x] task\n'); }
});
