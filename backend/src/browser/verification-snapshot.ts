import { ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import type { Work, WorkStore } from '../work/store';
import { pathsOverlap } from '../work/workspace-paths';
import { managedPrivatePath } from '../work/workspace-file-policy';
import type { VerificationEnvironment } from './verification-environment';

export interface VerificationSnapshot { id: string; root: string; revision: string; sourceRoot: string; environment?: VerificationEnvironment; }
export interface VerificationOutput { path: string; hash: string; size: number; mode: number; }
type Entry = { kind: 'file'; path: string; hash: string; mode: number; size: number } | { kind: 'directory'; path: string; mode: number };
type Budget = { signal?: AbortSignal; deadline: number };
const excluded = (path: string) => managedPrivatePath(path) || path.split('/').some(part => ['.tools', '.idea-trash'].includes(part.toLowerCase()));
function fail(message: string): never { throw new ConflictException(message); }
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
function checkpoint(budget: Budget) { budget.signal?.throwIfAborted(); if (Date.now() > budget.deadline) fail('검증 사본 준비 시간이 초과됐습니다'); }
const budget = (signal?: AbortSignal): Budget => ({ signal, deadline: Date.now() + 120000 });
async function exists(path: string) { try { await lstat(path); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; } }
async function physicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error: any) { if (error.code !== 'ENOENT' || dirname(path) === path) throw error; return join(await physicalPath(dirname(path)), relative(dirname(path), path)); }
}
async function assertNoHostConfiguration(root: string) {
  const configured = [process.env.CONFIG_PATH, process.env.OPENSPEC_UI_CONFIG].filter((value): value is string => !!value);
  for (const value of configured.length ? configured : ['../config.local.json']) {
    const path = resolve(value);
    if (pathsOverlap(root, path) || pathsOverlap(root, await physicalPath(path))) fail('호스트 운영 설정이 포함된 소스는 검증 사본으로 복사할 수 없습니다. 설정을 작업 공간 밖으로 분리해 주세요');
  }
}

/** Reject reparse parents before creating or deleting a host-owned container. */
async function directory(path: string, create = false) {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create && !await exists(current)) await mkdir(current);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || key(await realpath(current)) !== key(current)) fail('검증 사본 경로에 링크 또는 다른 경계가 있습니다');
  }
  return absolute;
}

/** Hash/copy in 1 MiB asynchronous chunks, checking cancellation between reads. */
async function readOwned(root: string, path: string, limits: Budget, destination?: string) {
  checkpoint(limits);
  const absolute = join(root, path);
  await directory(dirname(absolute));
  if (key(await realpath(absolute)) !== key(resolve(absolute))) fail('파일의 링크 또는 실제 경계가 변경되었습니다');
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('링크 또는 공유 파일은 검증 사본으로 복사할 수 없습니다');
  if (before.size > 512 * 1024 ** 2) fail('검증 사본의 개별 파일 크기 한도를 초과했습니다');
  const fd = await open(absolute, 'r'); let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const opened = await fd.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) fail('복사 중 파일 소유가 변경되었습니다');
    if (destination) { await directory(dirname(destination), true); output = await open(destination, 'wx'); }
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 ** 2); let bytes = 0;
    while (true) {
      checkpoint(limits); const read = await fd.read(chunk, 0, chunk.length, null); if (!read.bytesRead) break;
      bytes += read.bytesRead; if (bytes > before.size) fail('복사 중 원본 파일 크기가 변경되었습니다');
      hash.update(chunk.subarray(0, read.bytesRead));
      if (output) { let written = 0; while (written < read.bytesRead) { checkpoint(limits); written += (await output.write(chunk, written, read.bytesRead - written, null)).bytesWritten; } }
    }
    const after = await lstat(absolute);
    if (key(await realpath(absolute)) !== key(resolve(absolute))) fail('복사 중 파일 부모의 링크 경계가 변경되었습니다');
    if (bytes !== before.size || after.isSymbolicLink() || after.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.mode !== before.mode) fail('복사 중 원본 파일이 변경되었습니다');
    if (output) { await output.close(); output = undefined; await chmod(destination!, before.mode & 0o777); }
    return { hash: hash.digest('hex'), mode: before.mode & 0o777, size: bytes };
  } finally { await output?.close(); await fd.close(); }
}

async function manifest(root: string, limits: Budget): Promise<Entry[]> {
  await directory(root); await assertNoHostConfiguration(root);
  const files: Entry[] = []; let bytes = 0;
  const visit = async (dir: string, prefix = '') => {
    checkpoint(limits); const before = await lstat(dir);
    if (!before.isDirectory() || before.isSymbolicLink() || key(await realpath(dir)) !== key(resolve(dir))) fail('소스 링크 또는 디렉터리 경계를 확인할 수 없습니다');
    if (prefix && await exists(join(dir, '.git'))) fail('중첩 Git 경계는 검증 사본으로 복사할 수 없습니다');
    if (files.length >= 100000) fail('검증 사본 항목 수 한도를 초과했습니다');
    files.push({ kind: 'directory', path: prefix, mode: before.mode & 0o777 });
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      checkpoint(limits); const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excluded(path)) continue;
      if (entry.isSymbolicLink()) fail('소스 링크는 검증 사본으로 복사할 수 없습니다');
      if (entry.isDirectory()) { await visit(join(dir, entry.name), path); continue; }
      const stat = await lstat(join(root, path)); bytes += stat.size;
      if (files.length >= 100000 || bytes > 4 * 1024 ** 3) fail('검증 사본 크기 한도를 초과했습니다');
      files.push({ kind: 'file', path, ...await readOwned(root, path, limits) });
    }
    const after = await lstat(dir);
    if (after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs) fail('복사 중 소스 디렉터리가 변경되었습니다');
  };
  await visit(root); return files;
}
const revision = (files: Entry[]) => createHash('sha256').update(JSON.stringify(files)).digest('hex');

/** Host-only copies. No claim that the original AI writer has stopped. */
export class VerificationSnapshots {
  private owned = new Map<string, { container: string; dev: number; ino: number }>();
  constructor(private store: WorkStore) {}
  async revision(root: string, signal?: AbortSignal) {
    const limits = budget(signal), first = revision(await manifest(root, limits));
    if (first !== revision(await manifest(root, limits))) fail('소스 상태 확인 중 파일이 변경되었습니다');
    return first;
  }
  /** Separate from raw copy equality. Only exact attested outputs and an explicit
   * planning-checkbox independence declaration affect this semantic projection. */
  async semanticRevision(root: string, outputs: string[], checkboxMetadata?: string, signal?: AbortSignal) {
    const limits = budget(signal), before = await manifest(root, limits), parents = new Set<string>();
    for (const output of outputs) { let parent = dirname(output).replace(/\\/g, '/'); while (parent !== '.') { parents.add(parent); parent = dirname(parent).replace(/\\/g, '/'); } }
    const files = before.filter(entry => !outputs.includes(entry.path) && !(entry.kind === 'directory' && parents.has(entry.path))).map(entry => ({ ...entry }));
    const metadata = files.find(entry => entry.path === checkboxMetadata);
    if (metadata?.kind === 'file') {
      if (metadata.size > 2 * 1024 ** 2) fail('계획 metadata 크기 한도를 초과했습니다');
      const fd = await open(join(root, metadata.path), 'r'); const chunks: Buffer[] = []; let bytes = 0;
      try { while (true) { checkpoint(limits); const chunk = Buffer.allocUnsafe(8192), read = await fd.read(chunk, 0, chunk.length, null); if (!read.bytesRead) break; bytes += read.bytesRead; if (bytes > 2 * 1024 ** 2) fail('계획 metadata 크기 한도를 초과했습니다'); chunks.push(chunk.subarray(0, read.bytesRead)); } }
      finally { await fd.close(); }
      const raw = Buffer.concat(chunks, bytes); if (createHash('sha256').update(raw).digest('hex') !== metadata.hash) fail('의미 기준을 읽는 동안 계획이 변경되었습니다');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^(\s*[-*+]\s+)\[[ xX]\](?=\s)/gm, '$1[ ]');
      metadata.hash = createHash('sha256').update(text).digest('hex'); metadata.size = Buffer.byteLength(text);
    }
    if (revision(await manifest(root, limits)) !== revision(before)) fail('의미 기준을 읽는 동안 실제 소스가 변경되었습니다');
    return revision(files);
  }
  async prepare(work: Work, sourceRoot: string, signal?: AbortSignal, environment?: VerificationEnvironment): Promise<VerificationSnapshot> {
    const limits = budget(signal); sourceRoot = await directory(sourceRoot); checkpoint(limits);
    const data = resolve(process.env.DATA_DIR || '../.data');
    for (const current of [...this.store.list(), work]) {
      for (const root of [current.projectPath, current.executionPath, current.workspace?.executionPath].filter((root): root is string => typeof root === 'string')) {
        if (pathsOverlap(data, root) || await exists(root) && pathsOverlap(data, await realpath(root))) fail('호스트 검증 사본 경로가 AI 작업 공간과 겹칩니다');
      }
    }
    await directory(data); const base = await directory(join(data, 'verification-snapshots'), true); checkpoint(limits);
    const id = randomUUID(), container = join(base, id), root = join(container, 'project');
    await mkdir(container); const stat = await lstat(container);
    this.owned.set(id, { container, dev: stat.dev, ino: stat.ino });
    const snapshot: VerificationSnapshot = { id, root, sourceRoot, revision: '', ...(environment ? { environment } : {}) };
    try {
      const marker = await open(join(container, 'owner.json'), 'wx');
      try { await marker.writeFile(JSON.stringify({ id, workId: work.id })); } finally { await marker.close(); }
      await mkdir(root);
      const before = await manifest(sourceRoot, limits); snapshot.revision = revision(before);
      for (const file of before) {
        if (file.kind === 'directory') { checkpoint(limits); await directory(join(root, file.path), true); continue; }
        const copied = await readOwned(sourceRoot, file.path, limits, join(root, file.path));
        if (copied.hash !== file.hash || copied.mode !== file.mode) fail('복사 중 원본 파일이 변경되었습니다');
      }
      // Set directory modes only after writing children, deepest first.
      for (const entry of [...before].reverse()) if (entry.kind === 'directory') { checkpoint(limits); await chmod(join(root, entry.path), entry.mode); }
      if (revision(await manifest(sourceRoot, limits)) !== snapshot.revision || revision(await manifest(root, limits)) !== snapshot.revision) fail('복사 중 원본 또는 사본이 변경되었습니다');
      if (environment) {
        const container = join(data, 'verification-environments', environment.environmentId);
        if (!/^[a-f0-9-]{36}$/.test(environment.environmentId) || environment.workId !== work.id || key(environment.executionPath) !== key(sourceRoot) || environment.sourceRevision !== snapshot.revision || environment.dataPath !== join(container, 'data') || environment.evidencePath !== join(container, 'evidence')) fail('환경과 독립 사본 출처가 다릅니다');
        await directory(join(data, 'verification-environments'), true); await mkdir(container);
        const marker = await open(join(container, 'owner.json'), 'wx'); try { await marker.writeFile(JSON.stringify({ environmentId: environment.environmentId, workId: work.id, snapshotId: id, targetVersion: environment.targetVersion })); } finally { await marker.close(); }
        await mkdir(environment.dataPath); await mkdir(environment.evidencePath);
      }
      return snapshot;
    } catch (error) { try { await this.cleanup(snapshot); } catch { /* Preserve an unconfirmed container. */ } throw error; }
  }
  async matches(snapshot: VerificationSnapshot, root: string, signal?: AbortSignal, outputs: VerificationOutput[] = []) {
    try {
      if (key(await directory(root)) !== key(snapshot.sourceRoot)) return false;
      const limits = budget(signal), source = await manifest(root, limits); if (revision(source) !== snapshot.revision) return false;
      const actual = await manifest(snapshot.root, limits);
      const expected = new Map(source.map(entry => [entry.path, entry]));
      // Original inputs remain unchanged. Only exact, freshly-attested output files
      // may differ in the independent copy; no directory-wide source exclusions.
      for (const file of outputs) {
        if (!/^(?:dist|build)\//.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') || managedPrivatePath(file.path) || !/^[a-f0-9]{64}$/.test(file.hash)) return false;
        expected.set(file.path, { kind: 'file', ...file });
        let parent = dirname(file.path).replace(/\\/g, '/');
        while (parent !== '.' && !expected.has(parent)) {
          const entry = actual.find(entry => entry.path === parent); if (entry?.kind !== 'directory') return false; expected.set(parent, entry); parent = dirname(parent).replace(/\\/g, '/');
        }
      }
      const canonical = (entries: Entry[]) => JSON.stringify(entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(entry => entry.kind === 'file' ? [entry.kind, entry.path, entry.hash, entry.mode, entry.size] : [entry.kind, entry.path, entry.mode]));
      return canonical(actual) === canonical([...expected.values()]);
    }
    catch { return false; }
  }
  async cleanup(snapshot: VerificationSnapshot) {
    const owned = this.owned.get(snapshot.id);
    if (!owned || snapshot.root !== join(owned.container, 'project')) fail('검증 사본 소유 경로를 확인할 수 없습니다');
    await directory(owned.container);
    const stat = await lstat(owned.container), marker = JSON.parse(await readFile(join(owned.container, 'owner.json'), 'utf8'));
    if (stat.dev !== owned.dev || stat.ino !== owned.ino || marker.id !== snapshot.id) fail('검증 사본 소유가 변경되어 보존합니다');
    // Remove only the exact exclusively-created container; never follow links.
    await rm(owned.container, { recursive: true, force: false }); this.owned.delete(snapshot.id);
  }
}
