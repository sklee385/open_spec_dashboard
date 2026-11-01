import { BadRequestException, NotFoundException } from '@nestjs/common';
import { lstatSync, readdirSync } from 'node:fs';
import { within } from '../files';

const excludedDirectories = new Set(['node_modules', 'attachments', 'uploads']);
export function allowedWorkDocument(path: unknown, git: boolean): path is string {
  if (typeof path !== 'string' || !path || /[\\\x00-\x1f\x7f:]/.test(path)) return false;
  if (path === '.openspec.yaml') return git;
  const parts = path.split('/');
  return parts.length <= 17 && /\.md$/i.test(path) && parts.every(part => !!part && !part.startsWith('.') && !excludedDirectories.has(part.toLowerCase())) && (git || parts[0].toLowerCase() !== 'source-ideas');
}
export const corePlanDocument = (path: string) => /^(proposal|design|tasks)\.md$/.test(path) || /^specs\/.+\.md$/.test(path);
export function workDocumentPath(root: string, path: string) {
  try {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const stat = lstatSync(within(root, parts.slice(0, i).join('/')));
      if (stat.isSymbolicLink()) throw new BadRequestException('링크 문서 경로는 허용되지 않습니다');
      if (i === parts.length && (!stat.isFile() || stat.nlink !== 1 || stat.size > 2000000)) throw new NotFoundException('표시 가능한 문서가 없습니다');
    }
    return within(root, path);
  } catch (error: any) { if (error.code === 'ENOENT') throw new NotFoundException('문서가 없습니다'); throw error; }
}
/** Inventory only this change, never follow links or read every document body. */
export function workDocumentList(root: string, git: boolean): string[] {
  const files: string[] = [];
  const walk = (prefix = '', depth = 0) => {
    if (depth > 16 || files.length > 1000) throw new BadRequestException('변경 문서 목록의 깊이 또는 개수 한도를 초과했습니다');
    for (const entry of readdirSync(within(root, prefix || '.'), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || excludedDirectories.has(entry.name.toLowerCase()) || !git && !prefix && entry.name.toLowerCase() === 'source-ideas') continue;
        walk(name, depth + 1);
      } else if (entry.isFile() && allowedWorkDocument(name, git)) {
        const stat = lstatSync(within(root, name));
        if (stat.nlink === 1 && stat.size <= 2000000) files.push(name);
        if (files.length > 1000) throw new BadRequestException('변경 문서 목록의 개수 한도를 초과했습니다');
      }
    }
  };
  walk();
  const core = ['proposal.md', 'design.md', 'tasks.md', ...files.filter(p => p.startsWith('specs/')), '.openspec.yaml', ...files.filter(p => p.startsWith('source-ideas/')), 'verification.md'];
  return [...new Set([...core.filter(p => files.includes(p)), ...files])];
}
