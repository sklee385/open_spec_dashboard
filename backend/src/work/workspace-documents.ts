import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, openSync, closeSync, fstatSync, ftruncateSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { inspectWorkspacePath } from './workspace-paths';
export interface DocumentFile { path: string; hash: string; bytes: number; }
export interface DocumentManifest { version: 1; files: DocumentFile[]; revision: string; planRevision: string; }
export function isWorkspaceDocument(path: string, change: string) {
  const prefix = `openspec/changes/${change}/`;
  if (!path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  return ['proposal.md', 'design.md', 'tasks.md', '.openspec.yaml'].includes(name) || /^(?:specs|source-ideas)\/.+\.md$/.test(name);
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function documentPlanRevision(files: { path: string; content: Buffer }[]) {
  return hash(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => {
    let text = new TextDecoder('utf-8', { fatal: true }).decode(file.content).replace(/\r\n/g, '\n');
    if (file.path.endsWith('/tasks.md')) text = text.replace(/^(\s*[-*+]\s+)\[[ xX]\](?=\s)/gm, '$1[ ]');
    return [file.path, hash(text)];
  })));
}
const entry = (path: string) => { try { return lstatSync(path); } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; } };
function scan(project: string, change: string, required: boolean) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change)) throw new ConflictException('변경 문서 경계가 올바르지 않습니다.');
  if (!inspectWorkspacePath(project, []).exists) throw new ConflictException('문서 프로젝트가 없습니다.');
  const root = join(project, 'openspec', 'changes', change), buffers = new Map<string, Buffer>();
  let bytes = 0;
  const file = (path: string) => {
    inspectWorkspacePath(dirname(path), []);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new ConflictException('링크 또는 다른 소유와 공유된 문서는 가져올 수 없습니다.');
    if (before.size > 2 * 1024 ** 2 || (bytes += before.size) > 16 * 1024 ** 2 || buffers.size >= 10000) throw new ConflictException('검토 문서 크기 한도를 초과했습니다.');
    const descriptor = openSync(path, 'r');
    let content: Buffer;
    try {
      const opened = fstatSync(descriptor);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) throw new ConflictException('열기 전 문서 소유가 변경되었습니다.');
      content = readFileSync(descriptor);
    } finally { closeSync(descriptor); }
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size || after.isSymbolicLink() || after.nlink !== 1) throw new ConflictException('읽는 중 문서가 변경되었습니다.');
    const name = relative(project, path).split(sep).join('/');
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    buffers.set(name, content);
  };
  const tree = (path: string, depth = 0) => {
    if (!entry(path)) return;
    if (depth > 32) throw new ConflictException('문서 경로 깊이 한도를 초과했습니다.');
    inspectWorkspacePath(path, []);
    for (const name of readdirSync(path).sort()) {
      if (name === '.git') throw new ConflictException('Git 관리 파일은 문서로 가져올 수 없습니다.');
      const child = join(path, name), stat = lstatSync(child);
      if (stat.isSymbolicLink()) throw new ConflictException('링크 문서 경로를 사용할 수 없습니다.');
      if (stat.isDirectory()) tree(child, depth + 1);
      else if (name.endsWith('.md')) file(child);
    }
  };
  inspectWorkspacePath(root, []);
  for (const name of ['proposal.md', 'design.md', 'tasks.md', '.openspec.yaml']) {
    const path = join(root, name);
    if (entry(path)) file(path);
    else if (required && name !== '.openspec.yaml') throw new ConflictException('검토할 필수 문서가 없습니다.');
  }
  tree(join(root, 'specs')); tree(join(root, 'source-ideas'));
  if (required && ![...buffers.keys()].some(name => name.startsWith(`openspec/changes/${change}/specs/`))) throw new ConflictException('검토할 변경 명세가 없습니다.');
  const files = [...buffers].map(([path, content]) => ({ path, hash: hash(content), bytes: content.length })).sort((a, b) => a.path.localeCompare(b.path));
  const names = files.map(file => process.platform === 'win32' ? file.path.toLowerCase() : file.path);
  if (new Set(names).size !== names.length) throw new ConflictException('대소문자가 겹치는 문서 경로입니다.');
  const manifest: DocumentManifest = { version: 1, files, revision: hash(JSON.stringify(files)), planRevision: documentPlanRevision([...buffers].map(([path, content]) => ({ path, content }))) };
  return { manifest, buffers };
}
export function collectWorkspaceDocuments(project: string, change: string): DocumentManifest { return scan(project, change, true).manifest; }
export function copyWorkspaceDocuments(source: string, target: string, change: string, reviewedRevision: string): DocumentManifest {
  inspectWorkspacePath(target, [source]);
  const before = scan(source, change, true);
  if (before.manifest.revision !== reviewedRevision) throw new ConflictException('문서가 변경되었습니다. 최신 문서를 다시 검토해 주세요.');
  const existing = scan(target, change, false), wanted = new Set(before.manifest.files.map(file => file.path));
  for (const file of existing.manifest.files.filter(file => !wanted.has(file.path))) {
    const path = join(target, file.path); inspectWorkspacePath(dirname(path), [source]);
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || hash(readFileSync(path)) !== file.hash) throw new ConflictException('기존 업무 문서가 변경되었습니다.');
    unlinkSync(path); // Only stale allowlisted files from this new workspace, never directories/source.
  }
  for (const file of before.manifest.files) {
    const path = join(target, file.path); inspectWorkspacePath(dirname(path), [source]); mkdirSync(dirname(path), { recursive: true }); inspectWorkspacePath(dirname(path), [source]);
    const stat = entry(path);
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new ConflictException('업무 문서의 소유 경로를 확인해 주세요.');
    const descriptor = openSync(path, stat ? 'r+' : 'wx');
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || stat && (opened.dev !== stat.dev || opened.ino !== stat.ino)) throw new ConflictException('쓰기 전 문서 소유가 변경되었습니다.');
      ftruncateSync(descriptor); writeFileSync(descriptor, before.buffers.get(file.path)!);
    } finally { closeSync(descriptor); }
  }
  if (collectWorkspaceDocuments(source, change).revision !== reviewedRevision || collectWorkspaceDocuments(target, change).revision !== reviewedRevision) throw new ConflictException('문서 복사 중 내용이 변경되었습니다. 재검토·복구가 필요합니다.');
  return before.manifest;
}
