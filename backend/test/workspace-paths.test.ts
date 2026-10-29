import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { inspectWorkspacePath } from '../src/work/workspace-paths';

describe('작업 공간 경로 경계', () => {
  let root: string, protectedPaths: string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'workspace-paths-'));
    protectedPaths = ['project', 'data', 'config', 'install'].map(name => join(root, name));
    for (const path of protectedPaths) mkdirSync(path);
  });
  it('한글·공백 경로와 존재하는 실부모를 고정하고 검사만으로 폴더를 만들지 않는다', () => {
    const path = join(root, '업무 공간', '새 폴더');
    expect(inspectWorkspacePath(path, protectedPaths)).toMatchObject({ path, ancestor: root, exists: false });
    mkdirSync(join(root, '업무 공간'));
    expect(inspectWorkspacePath(path, protectedPaths).ancestor).toBe(join(root, '업무 공간'));
  });
  it('상대 경로·UNC·장치 경로·드라이브 루트·보호 영역 양방향 포함을 거부한다', () => {
    for (const path of ['relative', '\\\\server\\share', '\\\\?\\C:\\data', parse(root).root, ...protectedPaths, ...protectedPaths.map(p => join(p, 'child')), root, dirname(root)]) {
      expect(() => inspectWorkspacePath(path, protectedPaths), path).toThrow();
    }
    if (process.platform === 'win32') {
      expect(() => inspectWorkspacePath(join(root, 'PROJECT', 'child'), protectedPaths)).toThrow();
      for (const segment of ['name:stream', 'name.', 'name ', 'CON', 'NUL.txt']) expect(() => inspectWorkspacePath(join(root, segment), protectedPaths)).toThrow();
    }
  });
  it('junction·파일·끊긴 링크·중간 링크를 거부한다', () => {
    const linked = join(root, 'linked'), dangling = join(root, 'dangling');
    symlinkSync(protectedPaths[0], linked, 'junction');
    symlinkSync(join(root, 'missing'), dangling, 'junction');
    writeFileSync(join(root, 'file'), 'preserved');
    for (const path of [linked, join(linked, 'child'), dangling, join(dangling, 'child'), join(root, 'file')]) expect(() => inspectWorkspacePath(path, protectedPaths)).toThrow();
  });
});
