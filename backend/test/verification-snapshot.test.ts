import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync, symlinkSync, rmSync, openSync, ftruncateSync, closeSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore, type Work } from '../src/work/store';
import { VerificationSnapshots } from '../src/browser/verification-snapshot';

const roots: string[] = [];
let store: WorkStore | undefined;
const originalConfigEnvironment = { CONFIG_PATH: process.env.CONFIG_PATH, OPENSPEC_UI_CONFIG: process.env.OPENSPEC_UI_CONFIG };
afterEach(() => { store?.onApplicationShutdown(); store = undefined; delete process.env.DATA_DIR; for (const [name, value] of Object.entries(originalConfigEnvironment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'verification-copy-')); roots.push(dir);
  const root = join(dir, 'source'); mkdirSync(root); process.env.DATA_DIR = join(dir, 'data'); store = new WorkStore();
  const work: Work = { id: 'a', sourceId: 's', projectPath: root, executionPath: root, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'implementation', state: 'running', threadId: 'thread-a', turnId: 'turn-a', reviewedVersion: null, createdAt: '', updatedAt: '' };
  store.save(work); writeFileSync(join(root, 'server.cjs'), 'original');
  return { dir, root, work, manager: new VerificationSnapshots(store) };
}
it('호스트 사본은 소스·의존성·빌드의 독립 파일이며 원본 변경과 분리된다', async () => {
  const f = setup();
  for (const name of ['node_modules/pkg', 'dist']) { mkdirSync(join(f.root, name), { recursive: true }); writeFileSync(join(f.root, name, 'file.js'), name); }
  const snapshot = await f.manager.prepare(f.work, f.root);
  expect(snapshot.root.startsWith(process.env.DATA_DIR!)).toBe(true);
  expect(readFileSync(join(snapshot.root, 'server.cjs'), 'utf8')).toBe('original');
  expect(readFileSync(join(snapshot.root, 'node_modules/pkg/file.js'), 'utf8')).toBe('node_modules/pkg');
  expect(readFileSync(join(snapshot.root, 'dist/file.js'), 'utf8')).toBe('dist');
  expect(await f.manager.matches(snapshot, f.root)).toBe(true);
  writeFileSync(join(f.root, 'server.cjs'), 'changed');
  expect(readFileSync(join(snapshot.root, 'server.cjs'), 'utf8')).toBe('original');
  expect(await f.manager.matches(snapshot, f.root)).toBe(false);
  await f.manager.cleanup(snapshot); expect(existsSync(snapshot.root)).toBe(false);
});
it('개인 설정·운영 데이터·수정 가능한 CLI는 사본에 포함하지 않는다', async () => {
  const f = setup();
  for (const name of ['.git', '.data', '.logs', '.reference', '.codex', '.aws', '.tools/browser-verification']) { mkdirSync(join(f.root, name), { recursive: true }); writeFileSync(join(f.root, name, 'private'), 'private'); }
  writeFileSync(join(f.root, '.env'), 'secret');
  const snapshot = await f.manager.prepare(f.work, f.root);
  for (const name of ['.git', '.data', '.logs', '.reference', '.codex', '.aws', '.tools', '.env']) expect(existsSync(join(snapshot.root, name))).toBe(false);
  await f.manager.cleanup(snapshot);
});
it('원본과 겹치는 호스트 데이터 경로 또는 다른 AI 공간을 거부한다', async () => {
  const f = setup(); process.env.DATA_DIR = join(f.root, '.data');
  await expect(f.manager.prepare(f.work, f.root)).rejects.toThrow(/겹/);
  process.env.DATA_DIR = join(f.dir, 'data');
  store!.save({ ...f.work, id: 'b', requestKey: 'b', sourceId: 'b', projectPath: process.env.DATA_DIR!, executionPath: process.env.DATA_DIR!, changeName: 'b' });
  await expect(f.manager.prepare(f.work, f.root)).rejects.toThrow(/겹/);
});
it('공유 하드링크와 디렉터리 junction을 따라 복사하지 않는다', async () => {
  const f = setup(); linkSync(join(f.root, 'server.cjs'), join(f.root, 'shared.cjs'));
  await expect(f.manager.prepare(f.work, f.root)).rejects.toThrow(/링크|공유/);
  rmSync(join(f.root, 'shared.cjs'));
  const external = join(f.dir, 'external'); mkdirSync(external); symlinkSync(external, join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(f.manager.prepare(f.work, f.root)).rejects.toThrow(/링크|경계/);
});
it('사본 소스가 바뀌면 원본이 같아도 무효화한다', async () => {
  const f = setup(), snapshot = await f.manager.prepare(f.work, f.root);
  writeFileSync(join(snapshot.root, 'server.cjs'), 'test server altered source');
  expect(await f.manager.matches(snapshot, f.root)).toBe(false);
  await f.manager.cleanup(snapshot);
});
it('tasks 체크 상태도 바이트 변경으로 검출한다', async () => {
  const f = setup(); writeFileSync(join(f.root, 'tasks.md'), '- [ ] test');
  const snapshot = await f.manager.prepare(f.work, f.root);
  writeFileSync(join(f.root, 'tasks.md'), '- [x] test');
  expect(await f.manager.matches(snapshot, f.root)).toBe(false); await f.manager.cleanup(snapshot);
});
function largeFile(root: string, size = 128 * 1024 ** 2) { const fd = openSync(join(root, 'z-large.bin'), 'wx'); try { ftruncateSync(fd, size); } finally { closeSync(fd); } }
async function copiedFirstFile(f: ReturnType<typeof setup>, name = 'server.cjs') {
  const base = join(process.env.DATA_DIR!, 'verification-snapshots');
  await expect.poll(() => existsSync(base) && readdirSync(base).some(id => existsSync(join(base, id, 'project', name))), { interval: 2, timeout: 10000 }).toBe(true);
}
it('비동기 복사 중 원본이 바뀌면 사본을 실행 가능 결과로 반환하지 않는다', async () => {
  const f = setup(); largeFile(f.root);
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 1);
  const pending = f.manager.prepare(f.work, f.root); const outcome = pending.then(() => null, error => error);
  try { await copiedFirstFile(f); writeFileSync(join(f.root, 'server.cjs'), 'changed after first copy'); expect(await outcome).toBeInstanceOf(Error); expect(ticks).toBeGreaterThan(2); }
  finally { clearInterval(timer); }
}, 15000);
it('복사 중 부모 junction 교체는 경계 실패로 차단하고 외부 파일을 보존한다', async () => {
  const f = setup(); mkdirSync(join(f.root, 'a')); writeFileSync(join(f.root, 'a/code.cjs'), 'source'); largeFile(f.root);
  const external = join(f.dir, 'external'); mkdirSync(external); writeFileSync(join(external, 'code.cjs'), 'external');
  const pending = f.manager.prepare(f.work, f.root); const outcome = pending.then(() => null, error => error);
  await copiedFirstFile(f, 'a/code.cjs');
  // Windows may briefly deny a parent rename until the copy closes its file handle.
  await expect.poll(() => { try { renameSync(join(f.root, 'a'), join(f.root, 'saved-a')); return true; } catch { return false; } }, { interval: 2, timeout: 1000 }).toBe(true);
  symlinkSync(external, join(f.root, 'a'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(await outcome).toBeInstanceOf(Error); expect(readFileSync(join(external, 'code.cjs'), 'utf8')).toBe('external');
}, 15000);
it('크기 제한은 대용량 파일을 메모리에 읽기 전에 검사한다', async () => {
  const f = setup(); largeFile(f.root, 512 * 1024 ** 2 + 1);
  await expect(f.manager.prepare(f.work, f.root)).rejects.toThrow(/개별 파일 크기/);
});
it.each(['CONFIG_PATH', 'OPENSPEC_UI_CONFIG'])('%s의 실제 일반 이름 설정 파일을 검증 사본으로 유출하지 않는다', async name => {
  const f = setup(), config = join(f.root, 'config.local.json'); writeFileSync(config, '{"token":"host-private"}'); process.env[name] = config;
  await expect(f.manager.prepare(f.work, f.root)).rejects.toThrow(/설정/);
});
it('설정 경로의 외부 junction 별칭과 Windows 대소문자도 실제 경계로 검사한다', async () => {
  const f = setup(); writeFileSync(join(f.root, 'config.local.json'), 'host-private');
  const alias = join(f.dir, 'source-alias'); symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const config = join(alias, 'config.local.json'); process.env.CONFIG_PATH = process.platform === 'win32' ? config.toUpperCase() : config;
  await expect(f.manager.prepare(f.work, f.root)).rejects.toThrow(/설정/);
});
it('빈 디렉터리도 독립 사본에 유지하여 정상 서버의 상대 파일 쓰기가 가능하다', async () => {
  const f = setup(); mkdirSync(join(f.root, 'uploads/empty'), { recursive: true });
  const snapshot = await f.manager.prepare(f.work, f.root);
  expect(existsSync(join(snapshot.root, 'uploads/empty'))).toBe(true);
  writeFileSync(join(snapshot.root, 'uploads/probe'), 'fixture');
  expect(readFileSync(join(snapshot.root, 'uploads/probe'), 'utf8')).toBe('fixture');
  expect(existsSync(join(f.root, 'uploads/probe'))).toBe(false);
  await f.manager.cleanup(snapshot);
});
it.each(['add', 'remove'])('빈 디렉터리 %s 변경도 검증 소스 변경으로 판정한다', async operation => {
  const f = setup(); mkdirSync(join(f.root, 'empty'));
  const snapshot = await f.manager.prepare(f.work, f.root);
  if (operation === 'add') mkdirSync(join(f.root, 'new-empty')); else rmSync(join(f.root, 'empty'), { recursive: true });
  expect(await f.manager.matches(snapshot, f.root)).toBe(false); await f.manager.cleanup(snapshot);
});
