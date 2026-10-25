import { BadRequestException } from '@nestjs/common';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export function within(root: string, input: string): string {
  const base = realpathSync(root);
  const target = resolve(base, input);
  const check = (path: string) => {
    const rel = relative(base, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new BadRequestException('Path is outside project');
  };
  check(target);
  let parent = target;
  while (!existsSync(parent)) parent = dirname(parent);
  check(realpathSync(parent));
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new BadRequestException('Symbolic link is not allowed');
  return target;
}
export function textFile(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
export function atomicWrite(path: string, content: string) {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try { writeFileSync(temp, content, { flag: 'wx' }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch { /* Renamed files no longer have a temporary path. */ } }
}
