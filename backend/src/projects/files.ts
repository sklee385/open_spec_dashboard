import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, opendirSync, Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const MAX_TEXT = 1024 * 1024, PAGE = 200, MAX_DIRECTORY = 20000, MAX_SCAN = 3000;
const FIXED = new Set(['.git', '.data', '.tools', '.logs', '.codex', '.aws']);
const DEFAULT = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt', 'target', '__pycache__']);
export interface ProjectEntry { path: string; name: string; kind: 'file' | 'directory' | 'boundary'; version?: string; reason?: string; }
export interface ProjectFile { path: string; content: string | null; version: string; size: number; encoding: 'utf8' | null; bom: boolean; newline: 'crlf' | 'lf' | 'mixed' | 'none'; editable: boolean; reason?: string; }
interface Options { showHidden?: boolean; cursor?: string | null; }
interface Frame { path: string; after: string; }
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const equal = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root: string, path: string) => equal(root, path) || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)));
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** All public methods validate relative paths again; no watcher or shell command is used. */
export class ProjectFiles {
  private metadata = new Map<string, string[]>();
  private ignoreAvailable = new Map<string, boolean>();
  private gitEnvironment() { return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))); }
  private pointer(path: string) {
    let fd: number | undefined;
    try {
      const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return null;
      fd = openSync(path, 'r'); const buffer = Buffer.alloc(8193), length = readSync(fd, buffer, 0, buffer.length, 0);
      return length > 8192 ? null : new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)).replace(/\r?\n$/, '');
    } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  }
  private root(root: string) {
    let result: string;
    try { result = realpathSync(root); if (!lstatSync(result).isDirectory()) throw new Error(); } catch { throw new NotFoundException('Project not found'); }
    const metadata: string[] = [];
    for (const arg of ['--absolute-git-dir', '--git-common-dir']) {
      const git = spawnSync('git', ['-C', result, 'rev-parse', '--path-format=absolute', arg], { encoding: 'utf8', env: this.gitEnvironment(), shell: false, windowsHide: true, timeout: 5000, maxBuffer: 65536 });
      if (git.status === 0) { try { metadata.push(realpathSync(resolve(result, git.stdout.replace(/\r?\n$/, '')))); } catch {} }
    }
    this.ignoreAvailable.set(result, metadata.length > 0);
    // Git may be absent. Its on-disk pointer still identifies excluded metadata.
    const pointer = this.pointer(join(result, '.git'));
    if (pointer?.startsWith('gitdir: ')) {
      try {
        const directory = realpathSync(resolve(result, pointer.slice(8))); metadata.push(directory);
        const common = this.pointer(join(directory, 'commondir'));
        if (common) metadata.push(realpathSync(resolve(directory, common)));
      } catch {}
    }
    this.metadata.set(result, metadata);
    return result;
  }
  private normalized(path: string, allowEmpty = false) {
    if (typeof path !== 'string' || path.length > 4096 || (!path && !allowEmpty) || /[\\:\0]/.test(path) || isAbsolute(path)) throw new BadRequestException('Invalid project path');
    if (!path && allowEmpty) return '';
    if (path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /[<>"|?*]/.test(p) || /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p))) throw new BadRequestException('Invalid project path');
    return path;
  }
  private fixed(root: string, path: string) {
    if (path.split('/').some(p => FIXED.has(p.toLowerCase()))) return true;
    const absolute = resolve(root, path);
    if ((this.metadata.get(root) ?? []).some(metadata => inside(metadata, absolute))) return true;
    const runtime = [process.env.DATA_DIR || '../.data', process.env.CONFIG_PATH || process.env.OPENSPEC_UI_CONFIG || '../config.local.json'];
    for (const runtimePath of runtime) {
      let excluded = resolve(runtimePath); try { excluded = realpathSync(excluded); } catch {}
      if (inside(excluded, absolute)) return true;
    }
    return false;
  }
  private checked(root: string, path: string, missing = false, allowEmpty = false) {
    this.normalized(path, allowEmpty);
    if (this.fixed(root, path)) throw new ForbiddenException('Runtime or Git metadata is excluded');
    let current = root;
    const parts = path ? path.split('/') : [];
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      let stat: Stats;
      try { stat = lstatSync(current); } catch (error: any) {
        if (error.code === 'ENOENT' && missing) return join(root, ...parts);
        if (error.code === 'ENOENT') throw new NotFoundException('Entry not found');
        throw error;
      }
      const canonical = realpathSync(current);
      if (stat.isSymbolicLink() || !inside(root, canonical)) throw new ForbiddenException('Links and junctions are excluded');
      if (this.fixed(root, relative(root, canonical).split(sep).join('/'))) throw new ForbiddenException('Runtime or Git metadata is excluded');
      if (stat.isDirectory() && existsSync(join(current, '.git'))) throw new ForbiddenException('Nested repository boundary');
      if (i < parts.length - 1 && !stat.isDirectory()) throw new BadRequestException('Parent is not a directory');
    }
    return current;
  }
  /** Git paths may refer to deleted entries; every still-existing ancestor is checked. */
  validate(root: string, path: string, options: { missing?: boolean } = {}) {
    return this.checked(this.root(root), path, options.missing ?? false);
  }
  /** One request-scoped metadata probe, then physical checks for every Git path. */
  validationScope(root: string) {
    const canonical = this.root(root);
    return (path: string, options: { missing?: boolean } = {}) => {
      if (!equal(realpathSync(root), canonical)) throw new ConflictException('Project root changed');
      return this.checked(canonical, path, options.missing ?? false);
    };
  }
  private names(path: string) {
    const dir = opendirSync(path), names: string[] = [];
    try { for (let item = dir.readSync(); item; item = dir.readSync()) { names.push(item.name); if (names.length > MAX_DIRECTORY) throw new PayloadTooLargeException('Directory entry limit exceeded'); } }
    finally { dir.closeSync(); }
    return names.sort(compare);
  }
  private ignored(root: string, paths: string[]) {
    const result = spawnSync('git', ['-C', root, 'check-ignore', '-z', '--stdin'], { input: Buffer.from(paths.map(p => p + '\0').join('')), env: this.gitEnvironment(), windowsHide: true, shell: false, timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    return { paths: new Set(result.status === 0 ? result.stdout.toString('utf8').split('\0').filter(Boolean) : []), unavailable: !!result.error || (result.status !== 0 && result.status !== 1) };
  }
  private entries(root: string, path: string, showHidden = false) {
    const directory = this.checked(root, path, false, true);
    if (!lstatSync(directory).isDirectory()) throw new BadRequestException('Not a directory');
    const candidates = this.names(directory).map(name => ({ name, path: path ? `${path}/${name}` : name })).filter(e => !this.fixed(root, e.path));
    const ignored = showHidden ? { paths: new Set<string>(), unavailable: !this.ignoreAvailable.get(root) } : this.ignored(root, candidates.map(e => e.path));
    const entries: ProjectEntry[] = [];
    for (const entry of candidates) {
      if (!showHidden && (entry.name.startsWith('.') || DEFAULT.has(entry.name.toLowerCase()) || ignored.paths.has(entry.path))) continue;
      const abs = join(root, entry.path), stat = lstatSync(abs);
      if (stat.isSymbolicLink() || !inside(root, realpathSync(abs))) continue;
      if (stat.isDirectory()) {
        if (existsSync(join(abs, '.git'))) entries.push({ ...entry, kind: 'boundary', reason: 'Nested repository; register separately' });
        else entries.push({ ...entry, kind: 'directory' });
      } else if (stat.isFile()) entries.push({ ...entry, kind: 'file' });
    }
    return { entries, ignoredUnavailable: ignored.unavailable };
  }
  private cursor(value: string | null | undefined, scope: string): any {
    if (!value) return null;
    try { if (value.length > 65536) throw new Error(); const data = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); if (data.scope !== scope) throw new Error(); return data.state; }
    catch { throw new BadRequestException('Invalid cursor'); }
  }
  private token(scope: string, state: unknown) { return Buffer.from(JSON.stringify({ scope, state })).toString('base64url'); }
  async tree(root: string, path = '', options: Options = {}) {
    root = this.root(root); this.normalized(path, true);
    const scope = digest(JSON.stringify([root, 'tree', path, !!options.showHidden]));
    const after = this.cursor(options.cursor, scope);
    if (after !== null && typeof after !== 'string') throw new BadRequestException('Invalid cursor');
    const result = this.entries(root, path, options.showHidden);
    const remaining = result.entries.filter(e => after === null || compare(e.name, after) > 0), entries = remaining.slice(0, PAGE);
    return { entries, nextCursor: remaining.length > PAGE ? this.token(scope, entries[entries.length - 1].name) : null, ignoredUnavailable: result.ignoredUnavailable };
  }
  async search(root: string, q: string, options: Options = {}) {
    root = this.root(root);
    if (typeof q !== 'string' || !q.trim() || q.length > 500) throw new BadRequestException('Invalid search');
    const scope = digest(JSON.stringify([root, 'search', q, !!options.showHidden]));
    const stack: Frame[] = this.cursor(options.cursor, scope) ?? [{ path: '', after: '' }];
    if (!Array.isArray(stack) || stack.length > 128 || stack.some(f => typeof f?.path !== 'string' || typeof f?.after !== 'string')) throw new BadRequestException('Invalid cursor');
    stack.forEach(f => this.normalized(f.path, true));
    const entries: ProjectEntry[] = []; let scanned = 0, ignoredUnavailable = false;
    const cache = new Map<string, ReturnType<ProjectFiles['entries']>>();
    while (stack.length && entries.length < PAGE && scanned < MAX_SCAN) {
      const frame = stack[stack.length - 1];
      let result = cache.get(frame.path);
      if (!result) { result = this.entries(root, frame.path, options.showHidden); cache.set(frame.path, result); }
      ignoredUnavailable ||= result.ignoredUnavailable;
      const next = result.entries.find(e => compare(e.name, frame.after) > 0);
      if (!next) { stack.pop(); continue; }
      frame.after = next.name; scanned++;
      if (next.path.toLowerCase().includes(q.toLowerCase())) entries.push(next);
      if (next.kind === 'directory') { if (stack.length >= 128) throw new PayloadTooLargeException('Directory depth limit exceeded'); stack.push({ path: next.path, after: '' }); }
    }
    return { entries, nextCursor: stack.length ? this.token(scope, stack) : null, ignoredUnavailable };
  }
  private snapshot(root: string, path: string): { file: ProjectFile; stat: Stats } {
    const absolute = this.checked(root, path), before = lstatSync(absolute);
    if (!before.isFile()) throw new BadRequestException('Not a regular file');
    const fd = openSync(absolute, 'r');
    try {
      const stat = fstatSync(fd);
      if (stat.dev !== before.dev || stat.ino !== before.ino || !equal(realpathSync(absolute), absolute)) throw new ConflictException('File identity changed');
      if (stat.size > MAX_TEXT) {
        const current = lstatSync(this.checked(root, path));
        if (!this.sameStat(stat, fstatSync(fd)) || !this.sameStat(stat, current)) throw new ConflictException('File changed while reading');
        const version = digest(JSON.stringify(['oversized-v1', stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
        return { file: { path, content: null, version, size: stat.size, encoding: null, bom: false, newline: 'none', editable: false, reason: 'File exceeds 1 MiB text limit' }, stat: current };
      }
      const hash = createHash('sha256'), chunks: Buffer[] = [], chunk = Buffer.alloc(65536); let size = 0;
      for (let count = readSync(fd, chunk, 0, Math.min(chunk.length, MAX_TEXT + 1 - size), null); count; count = readSync(fd, chunk, 0, Math.min(chunk.length, MAX_TEXT + 1 - size), null)) {
        size += count; hash.update(chunk.subarray(0, count)); if (size <= MAX_TEXT) chunks.push(Buffer.from(chunk.subarray(0, count)));
        if (size > stat.size) throw new ConflictException('File changed while reading');
      }
      const after = fstatSync(fd), current = lstatSync(this.checked(root, path));
      if (!this.sameStat(stat, after) || !this.sameStat(after, current) || size !== stat.size) throw new ConflictException('File changed while reading');
      const version = hash.digest('hex');
      const file: ProjectFile = { path, content: null, version, size, encoding: null, bom: false, newline: 'none', editable: false };
      if (size > MAX_TEXT) return { file: { ...file, reason: 'File exceeds 1 MiB text limit' }, stat: current };
      const bytes = Buffer.concat(chunks); file.bom = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bom ? bytes.subarray(3) : bytes);
        if (text.includes('\0')) return { file: { ...file, reason: 'Binary file' }, stat: current };
        const crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/(?<!\r)\n/g) || []).length, cr = (text.match(/\r(?!\n)/g) || []).length;
        return { file: { ...file, content: text, encoding: 'utf8', editable: true, newline: cr || (crlf && lf) ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none' }, stat: current };
      } catch { return { file: { ...file, reason: 'Unsupported encoding; UTF-8 required' }, stat: current }; }
    } finally { closeSync(fd); }
  }
  private sameStat(a: Stats, b: Stats) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
  async read(root: string, path: string) { return this.snapshot(this.root(root), path).file; }
  /** Explicit move confirmation only: browsing does not recursively inspect directories. */
  async entry(root: string, path: string): Promise<ProjectEntry> {
    root = this.root(root); const absolute = this.checked(root, path), stat = lstatSync(absolute);
    if (!stat.isFile() && !stat.isDirectory()) throw new BadRequestException('Unsupported entry kind');
    return { path, name: path.split('/').pop()!, kind: stat.isDirectory() ? 'directory' : 'file', version: stat.isDirectory() ? this.directoryVersion(root, path) : this.snapshot(root, path).file.version };
  }
  private conflict(root: string, path: string): never { let latest: ProjectFile | null = null; try { latest = this.snapshot(root, path).file; } catch {} throw new ConflictException({ message: 'File changed externally', latest }); }
  private current(root: string, path: string, version: string) {
    this.normalized(path);
    if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) throw new BadRequestException('File version required');
    try { const snapshot = this.snapshot(root, path); if (snapshot.file.version !== version) this.conflict(root, path); return snapshot; }
    catch (error) { if (error instanceof NotFoundException || error instanceof ForbiddenException || error instanceof BadRequestException) this.conflict(root, path); throw error; }
  }
  private encode(content: string, bom = false) { if (typeof content !== 'string' || content.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content)) throw new BadRequestException('Valid UTF-8 text required'); const bytes = Buffer.from((bom ? '\ufeff' : '') + content, 'utf8'); if (bytes.length > MAX_TEXT) throw new PayloadTooLargeException('File exceeds 1 MiB'); return bytes; }
  private mutation(body: unknown) { if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Mutation body required'); }
  async save(root: string, body: { path: string; content: string; version: string }) {
    this.mutation(body);
    root = this.root(root); const initial = this.current(root, body.path, body.version);
    if (!initial.file.editable) throw new BadRequestException('File cannot be edited');
    const bytes = this.encode(body.content, initial.file.bom), target = this.checked(root, body.path), parent = dirname(target), parentStat = lstatSync(parent), temp = join(parent, `.project-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', initial.stat.mode); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      const current = this.current(root, body.path, body.version);
      const currentParent = lstatSync(parent);
      if (!this.sameStat(initial.stat, current.stat) || parentStat.dev !== currentParent.dev || parentStat.ino !== currentParent.ino) this.conflict(root, body.path);
      this.checked(root, body.path); renameSync(temp, target);
    } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
    return this.snapshot(root, body.path).file;
  }
  async create(root: string, body: { path: string; kind: 'file' | 'directory'; content?: string }) {
    this.mutation(body);
    root = this.root(root); if (!['file', 'directory'].includes(body.kind)) throw new BadRequestException('Invalid entry kind');
    const target = this.checked(root, body.path, true);
    if (existsSync(target)) throw new ConflictException('Target already exists');
    try { if (body.kind === 'directory') mkdirSync(target); else writeFileSync(target, this.encode(body.content ?? ''), { flag: 'wx' }); }
    catch (error: any) { if (error.code === 'EEXIST') throw new ConflictException('Target already exists'); throw error; }
    return body.kind === 'file' ? this.snapshot(root, body.path).file : { path: body.path, name: body.path.split('/').pop()!, kind: 'directory' as const, version: this.directoryVersion(root, body.path) };
  }
  private directoryVersion(root: string, path: string) {
    const hash = createHash('sha256').update('directory-stat-v2'); let count = 0; const deadline = Date.now() + 1500;
    const visit = (rel: string, depth: number) => {
      if (++count > MAX_SCAN || depth > 128 || Date.now() > deadline) throw new PayloadTooLargeException('Directory inspection limit exceeded; move fewer entries');
      const absolute = this.checked(root, rel), stat = lstatSync(absolute);
      if (!stat.isDirectory() && !stat.isFile()) throw new BadRequestException('Unsupported entry kind');
      hash.update(JSON.stringify([rel.slice(path.length), stat.isDirectory() ? 'directory' : 'file', stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
      if (stat.isDirectory()) for (const name of this.names(absolute)) visit(`${rel}/${name}`, depth + 1);
    };
    visit(path, 0); return hash.digest('hex');
  }
  async move(root: string, body: { path: string; target: string; version: string }) {
    this.mutation(body);
    root = this.root(root); const source = this.checked(root, body.path), target = this.checked(root, body.target, true), stat = lstatSync(source);
    if (inside(source, target)) throw new BadRequestException('Cannot move into itself');
    if (existsSync(target)) throw new ConflictException('Target already exists');
    const version = stat.isDirectory() ? this.directoryVersion(root, body.path) : this.current(root, body.path, body.version).file.version;
    if (typeof body.version !== 'string' || version !== body.version) throw new ConflictException('Entry changed externally');
    const finalVersion = stat.isDirectory() ? this.directoryVersion(root, body.path) : this.current(root, body.path, body.version).file.version;
    const finalStat = lstatSync(this.checked(root, body.path)); this.checked(root, body.target, true);
    if (!this.sameStat(stat, finalStat) || finalVersion !== version || existsSync(target)) throw new ConflictException('Entry changed externally');
    renameSync(source, target); return { path: body.target, previousPath: body.path, version };
  }
  async remove(root: string, body: { path: string; version: string; confirmed: boolean }) {
    this.mutation(body);
    root = this.root(root); if (body.confirmed !== true) throw new BadRequestException('Explicit delete confirmation required');
    const snapshot = this.current(root, body.path, body.version), target = this.checked(root, body.path);
    if (!this.sameStat(snapshot.stat, lstatSync(target))) this.conflict(root, body.path);
    unlinkSync(target); return { path: body.path, deleted: true };
  }
}
