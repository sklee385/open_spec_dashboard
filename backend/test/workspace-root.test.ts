import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWorkspacePath } from '../src/work/workspace-paths';
import { probeWorkspacePath, registerWorkspaceRoot } from '../src/work/workspace-root';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
describe('공간 검사 파일과 소유 등록', () => {
  let root: string, profile: string;
  beforeEach(() => { vi.mocked(fs.openSync).mockClear(); root = fs.mkdtempSync(join(tmpdir(), 'workspace-root-')); profile = randomUUID(); });
  it('고유 probe만 제거하고 기존 내용과 다른 프로필 폴더를 보존한다', () => {
    fs.writeFileSync(join(root, 'keep.txt'), 'existing');
    fs.mkdirSync(join(root, `openspecboard-${randomUUID()}`));
    const before = fs.readdirSync(root);
    probeWorkspacePath(inspectWorkspacePath(root, []));
    expect(fs.readdirSync(root)).toEqual(before);
    const result = registerWorkspaceRoot(inspectWorkspacePath(root, []), [], profile);
    expect(result).toMatchObject({ path: root, managedPath: join(root, `openspecboard-${profile}`) });
    expect(JSON.parse(fs.readFileSync(join(result.managedPath, 'identity.json'), 'utf8'))).toMatchObject({ profileId: profile, rootId: result.rootId });
    expect(registerWorkspaceRoot(inspectWorkspacePath(root, []), [], profile).rootId).toBe(result.rootId);
    expect(fs.readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('existing');
  });
  it('쓰기 거부를 성공으로 처리하지 않고 기존 파일을 보존한다', () => {
    fs.writeFileSync(join(root, 'keep.txt'), 'existing');
    vi.mocked(fs.openSync).mockImplementationOnce(() => { throw Object.assign(new Error('read only'), { code: 'EACCES' }); });
    expect(() => probeWorkspacePath(inspectWorkspacePath(root, []))).toThrow();
    expect(fs.readdirSync(root)).toEqual(['keep.txt']);
  });
  it('관리 폴더의 타 소유 identity와 소유 정보 없는 기존 폴더를 거부한다', () => {
    const managed = join(root, `openspecboard-${profile}`); fs.mkdirSync(managed);
    expect(() => registerWorkspaceRoot(inspectWorkspacePath(root, []), [], profile)).toThrow();
    fs.writeFileSync(join(managed, 'identity.json'), JSON.stringify({ profileId: randomUUID(), rootId: randomUUID() }));
    const before = fs.readFileSync(join(managed, 'identity.json'), 'utf8');
    expect(() => registerWorkspaceRoot(inspectWorkspacePath(root, []), [], profile)).toThrow();
    expect(fs.readFileSync(join(managed, 'identity.json'), 'utf8')).toBe(before);
  });
  it('검사 후 디렉터리 교체와 junction 교체를 거부하고 대상을 생성하지 않는다', () => {
    const path = join(root, 'selected'); fs.mkdirSync(path);
    const inspection = inspectWorkspacePath(path, []);
    fs.renameSync(path, join(root, 'old')); fs.mkdirSync(path);
    expect(() => registerWorkspaceRoot(inspection, [], profile)).toThrow();
    fs.renameSync(path, join(root, 'replacement')); fs.symlinkSync(join(root, 'old'), path, 'junction');
    expect(() => registerWorkspaceRoot(inspection, [], profile)).toThrow();
    expect(fs.readdirSync(join(root, 'old'))).toEqual([]);
  });
});
