import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectFiles } from '../src/projects/files';
import { ProjectResolver } from '../src/projects/resolver';
vi.mock('node:fs', async importOriginal => { const fs = await importOriginal<typeof import('node:fs')>(); return { ...fs, readSync: vi.fn(fs.readSync) }; });
let root: string;
const files = new ProjectFiles();
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'project-files-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
it('원본 BOM과 CRLF 및 끝 개행을 보존하며 외부 변경을 덮어쓰지 않는다', async () => {
  writeFileSync(join(root, '한 글 [x].txt'), Buffer.from('\ufeffa\r\nb\r\n'));
  const original = await files.read(root, '한 글 [x].txt');
  expect(original).toMatchObject({ content: 'a\r\nb\r\n', bom: true, newline: 'crlf', editable: true });
  await files.save(root, { path: original.path, content: 'c\r\n', version: original.version });
  expect(readFileSync(join(root, original.path), 'utf8')).toBe('\ufeffc\r\n');
  await expect(files.save(root, { path: original.path, content: 'lost', version: original.version })).rejects.toMatchObject({ status: 409 });
});
it('잘못된 인코딩과 대용량은 메타데이터만 반환한다', async () => {
  writeFileSync(join(root, 'bad'), Buffer.from([0xff, 0xfe]));
  writeFileSync(join(root, 'large'), Buffer.alloc(1048577, 65));
  expect(await files.read(root, 'bad')).toMatchObject({ editable: false, content: null });
  expect(await files.read(root, 'large')).toMatchObject({ editable: false, size: 1048577 });
});
it('경로 우회, 운영 데이터, 링크, 중첩 저장소를 차단한다', async () => {
  mkdirSync(join(root, '.git')); mkdirSync(join(root, '.data')); mkdirSync(join(root, 'nested')); mkdirSync(join(root, 'nested', '.git'));
  symlinkSync(root, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of ['../x', 'C:/x', '.git/config', '.data/a', 'file:stream', 'CON.txt', 'linked/x', 'nested/x']) await expect(files.read(root, path)).rejects.toBeDefined();
  const tree = await files.tree(root, '', { showHidden: true });
  expect(tree.entries.find(e => e.path === 'nested')?.kind).toBe('boundary');
  expect(tree.entries.some(e => ['.git', '.data', 'linked'].includes(e.path))).toBe(false);
});
it('정렬된 200개 페이지와 숨김 확장, 경로 검색을 제공한다', async () => {
  for (let i = 0; i < 205; i++) writeFileSync(join(root, `a${String(i).padStart(3, '0')}`), '');
  writeFileSync(join(root, '.hidden'), '');
  const first = await files.tree(root);
  expect(first.entries).toHaveLength(200); expect(first.nextCursor).toBeTruthy();
  expect((await files.tree(root, '', { cursor: first.nextCursor! })).entries).toHaveLength(5);
  expect((await files.search(root, '.hidden', { showHidden: true })).entries[0].path).toBe('.hidden');
});
it('생성, 버전 기반 이동, 확인 삭제에서 덮어쓰기와 폴더 삭제를 거부한다', async () => {
  await files.create(root, { path: 'dir', kind: 'directory' });
  await files.create(root, { path: 'dir/a', kind: 'file', content: 'hello' });
  await expect(files.create(root, { path: 'dir/a', kind: 'file' })).rejects.toMatchObject({ status: 409 });
  const file = await files.read(root, 'dir/a');
  await files.move(root, { path: 'dir/a', target: 'dir/b', version: file.version });
  await expect(files.remove(root, { path: 'dir/b', version: file.version, confirmed: false })).rejects.toBeDefined();
  await files.remove(root, { path: 'dir/b', version: file.version, confirmed: true });
  await expect(files.remove(root, { path: 'dir', version: '', confirmed: true })).rejects.toBeDefined();
});
it('실제 Git 무시 규칙과 linked worktree의 프로젝트 경계를 인식한다', async () => {
  execFileSync('git', ['init', root], { windowsHide: true });
  mkdirSync(join(root, 'openspec')); writeFileSync(join(root, '.gitignore'), 'ignored*\n'); writeFileSync(join(root, 'ignored.txt'), '');
  expect((await files.tree(root)).entries.some(e => e.path === 'ignored.txt')).toBe(false);
  expect((await files.tree(root, '', { showHidden: true })).entries.some(e => e.path === 'ignored.txt')).toBe(true);
  const resolver = new ProjectResolver({ sources: () => [{ id: 'p', path: join(root, 'openspec'), valid: true }] } as any);
  expect(await resolver.resolve('p')).toMatchObject({ root, gitRoot: root, boundary: true, gitAvailable: true });
  expect(() => resolver.resolve('missing')).toThrow('Project not found');
});
it('커스텀 Git 관리 디렉터리와 런타임 경로도 확장 조회에서 제외한다', async () => {
  execFileSync('git', ['init', '--separate-git-dir', join(root, 'metadata'), root], { windowsHide: true });
  mkdirSync(join(root, 'runtime')); writeFileSync(join(root, 'runtime', 'db'), 'secret');
  const previous = process.env.DATA_DIR; process.env.DATA_DIR = join(root, 'runtime');
  try {
    const entries = (await files.tree(root, '', { showHidden: true })).entries;
    expect(entries.some(e => ['metadata', 'runtime'].includes(e.path))).toBe(false);
    await expect(files.read(root, 'metadata/config')).rejects.toBeDefined();
  } finally { if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; }
});
it('폴더 이동은 모든 하위 파일 버전을 확인하고 자기 하위나 기존 대상으로 이동하지 않는다', async () => {
  await files.create(root, { path: 'dir', kind: 'directory' }); await files.create(root, { path: 'dir/a', kind: 'file', content: 'one' });
  const entry = await files.entry(root, 'dir');
  writeFileSync(join(root, 'dir', 'a'), 'two');
  await expect(files.move(root, { path: 'dir', target: 'renamed', version: entry.version! })).rejects.toMatchObject({ status: 409 });
  const updated = await files.entry(root, 'dir');
  await expect(files.move(root, { path: 'dir', target: 'dir/child', version: updated.version! })).rejects.toBeDefined();
  await files.move(root, { path: 'dir', target: 'renamed', version: updated.version! });
  expect(readFileSync(join(root, 'renamed', 'a'), 'utf8')).toBe('two');
});
it('삭제된 원본 저장은 409로 거부하고 최신 내용은 null이다', async () => {
  writeFileSync(join(root, 'gone'), 'text'); const original = await files.read(root, 'gone'); rmSync(join(root, 'gone'));
  await expect(files.save(root, { path: 'gone', content: 'draft', version: original.version })).rejects.toMatchObject({ status: 409, response: { latest: null } });
});
it('newline 포함 파일명과 문자 그대로의 Git 무시 입력을 처리한다', async () => {
  execFileSync('git', ['init', root], { windowsHide: true });
  const name = process.platform === 'win32' ? '한글 [abc] !name' : '한글\n[abc] !name';
  writeFileSync(join(root, name), 'a\nb');
  expect((await files.tree(root)).entries.some(e => e.path === name)).toBe(true);
  expect(await files.read(root, name)).toMatchObject({ content: 'a\nb', newline: 'lf' });
});
it('실제 linked worktree와 상위 저장소의 하위 프로젝트를 구분한다', async () => {
  execFileSync('git', ['init', root], { windowsHide: true });
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { windowsHide: true });
  const linked = join(root, 'linked'); execFileSync('git', ['-C', root, 'worktree', 'add', '-b', 'linked-fixture', linked], { windowsHide: true });
  mkdirSync(join(linked, 'openspec')); mkdirSync(join(root, 'sub')); mkdirSync(join(root, 'sub', 'openspec'));
  const resolver = new ProjectResolver({ sources: () => [{ id: 'linked', path: join(linked, 'openspec'), valid: true }, { id: 'sub', path: join(root, 'sub', 'openspec'), valid: true }] } as any);
  expect(await resolver.resolve('linked')).toMatchObject({ root: linked, gitRoot: linked, boundary: true, commonDir: join(root, '.git') });
  expect(await resolver.resolve('sub')).toMatchObject({ root: join(root, 'sub'), gitRoot: root, boundary: false });
});
it('Git이 없어도 기본 탐색과 숨김 확장을 사용할 수 있고 제한을 알린다', async () => {
  writeFileSync(join(root, 'source.txt'), 'text'); writeFileSync(join(root, '.hidden'), 'text');
  const previous = process.env.PATH; process.env.PATH = '';
  try {
    expect(await files.tree(root)).toMatchObject({ ignoredUnavailable: true, entries: [{ path: 'source.txt' }] });
    expect(await files.tree(root, '', { showHidden: true })).toMatchObject({ ignoredUnavailable: true });
  } finally { process.env.PATH = previous; }
});
it('Git batch guard는 삭제된 부모는 허용하고 숨은 경계는 계속 차단한다', () => {
  const guard = files.validationScope(root);
  expect(guard('removed/parent/file', { missing: true })).toBe(join(root, 'removed', 'parent', 'file'));
  expect(() => guard('removed/.git/config', { missing: true })).toThrow();
});

it('Git 실행 불가여도 gitdir 포인터의 커스텀 메타데이터를 숨긴다', async () => {
  execFileSync('git', ['init', '--separate-git-dir', join(root, 'metadata'), root], { windowsHide: true });
  const previous = process.env.PATH; process.env.PATH = '';
  try { expect((await files.tree(root, '', { showHidden: true })).entries.some(e => e.path === 'metadata')).toBe(false); }
  finally { process.env.PATH = previous; }
});
it('저장 직전 원본이 링크로 바뀌면 409이고 외부 내용은 수정하지 않는다', async () => {
  writeFileSync(join(root, 'source'), 'old'); writeFileSync(join(root, 'outside'), 'safe'); const original = await files.read(root, 'source');
  rmSync(join(root, 'source'));
  // Windows junctions are directory-only; a path replaced by a junction must also conflict.
  if (process.platform === 'win32') symlinkSync(root, join(root, 'source'), 'junction'); else symlinkSync(join(root, 'outside'), join(root, 'source'));
  await expect(files.save(root, { path: 'source', content: 'new', version: original.version })).rejects.toMatchObject({ status: 409 });
  expect(readFileSync(join(root, 'outside'), 'utf8')).toBe('safe');
});
it('잘못된 mutation 본문은 파일을 건드리지 않고 400으로 거부한다', async () => {
  for (const method of ['save', 'create', 'move', 'remove'] as const) await expect((files[method] as any)(root, null)).rejects.toMatchObject({ status: 400 });
});

it('파일이 폴더로 교체된 이후 저장은 최신 원문 null인 409다', async () => {
  writeFileSync(join(root, 'source'), 'old'); const original = await files.read(root, 'source');
  rmSync(join(root, 'source')); mkdirSync(join(root, 'source'));
  await expect(files.save(root, { path: 'source', content: 'draft', version: original.version })).rejects.toMatchObject({ status: 409, response: { latest: null } });
});
it('트리는 하위 소스와 숨겨진 빌드 파일 본문을 읽지 않고 폴더 버전은 이동 확인 때만 계산한다', async () => {
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'src', 'dist')); writeFileSync(join(root, 'src', 'source'), 'source');
  writeFileSync(join(root, 'src', 'dist', 'large'), ''); truncateSync(join(root, 'src', 'dist', 'large'), 64 * 1024 * 1024);
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs'); let bytes = 0;
  vi.mocked(readSync).mockImplementation(((...args: any[]) => { bytes += args[3]; if (bytes > 1048577) throw new Error('Read budget exceeded'); return (actual.readSync as any)(...args); }) as any);
  try {
    const tree = await files.tree(root); expect(tree.entries).toMatchObject([{ path: 'src', kind: 'directory' }]);
    expect(tree.entries[0].version).toBeUndefined(); expect(bytes).toBe(0);
    const entry = await files.entry(root, 'src'); expect(entry.version).toMatch(/^[a-f0-9]{64}$/); expect(bytes).toBe(0);
  } finally { vi.mocked(readSync).mockImplementation(actual.readSync); }
});
it('한도를 넘는 파일은 끝까지 읽지 않고 크기와 읽기 전용 메타데이터를 반환한다', async () => {
  writeFileSync(join(root, 'large'), ''); truncateSync(join(root, 'large'), 64 * 1024 * 1024);
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs'); let bytes = 0;
  vi.mocked(readSync).mockImplementation(((...args: any[]) => { bytes += args[3]; if (bytes > 1048577) throw new Error('Read budget exceeded'); return (actual.readSync as any)(...args); }) as any);
  try {
    const result = await files.read(root, 'large'); expect(result).toMatchObject({ size: 64 * 1024 * 1024, editable: false, content: null });
    expect(bytes).toBeLessThanOrEqual(1048577);
    await expect(files.save(root, { path: 'large', content: 'new', version: result.version })).rejects.toMatchObject({ status: 400 });
  } finally { vi.mocked(readSync).mockImplementation(actual.readSync); }
});
