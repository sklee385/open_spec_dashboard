import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export interface WorkspacePathInspection { path: string; ancestor: string; exists: boolean; fingerprint: string; }
const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
export function pathsOverlap(a: string, b: string) {
  const inside = (parent: string, child: string) => { const rel = relative(key(parent), key(child)); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  return inside(a, b) || inside(b, a);
}
function entry(path: string) {
  try { return lstatSync(path, { bigint: true }); }
  catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
}
/** Resolve from the real existing ancestor even when the last components are absent. */
function physicalPath(path: string): string {
  const stat = entry(path);
  if (stat) return realpathSync.native(path);
  const parent = dirname(path);
  if (parent === path) throw new BadRequestException('저장 드라이브를 확인할 수 없습니다.');
  return join(physicalPath(parent), relative(parent, path));
}
export function inspectWorkspacePath(input: string, protectedPaths: string[]): WorkspacePathInspection {
  if (typeof input !== 'string' || !input || /[\0\r\n]/.test(input) || !isAbsolute(input) || /^[\\/]{2}/.test(input) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(input))) throw new BadRequestException('실행 호스트의 절대 로컬 경로를 입력해 주세요.');
  const segments = input.slice(parse(input).root.length).split(/[\\/]/).filter(Boolean);
  if (segments.some(part => part === '..' || (process.platform === 'win32' && (/[<>:"|?*]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) throw new BadRequestException('지원하지 않는 경로 구성입니다.');
  const path = resolve(input);
  if (key(path) === key(parse(path).root)) throw new BadRequestException('드라이브 루트는 작업 공간으로 사용할 수 없습니다.');
  const chain: { path: string; dev: string; ino: string }[] = [];
  let current = parse(path).root, ancestor = current;
  for (const part of ['', ...relative(current, path).split(sep)]) {
    if (part) current = join(current, part);
    const stat = entry(current);
    if (!stat) break;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BadRequestException('링크·reparse 경로 또는 파일은 사용할 수 없습니다.');
    ancestor = current;
    chain.push({ path: key(ancestor), dev: String(stat.dev), ino: String(stat.ino) });
  }
  if (key(realpathSync.native(ancestor)) !== key(ancestor)) throw new BadRequestException('실부모가 다른 reparse 경로입니다.');
  for (const protectedPath of protectedPaths) {
    if (pathsOverlap(path, resolve(protectedPath)) || pathsOverlap(path, physicalPath(resolve(protectedPath)))) throw new BadRequestException('원본·데이터·설정·설치 보호 영역과 겹치는 경로입니다.');
  }
  return { path, ancestor, exists: key(ancestor) === key(path), fingerprint: createHash('sha256').update(JSON.stringify(chain)).digest('hex') };
}
