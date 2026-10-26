import { ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { within } from '../files';
import { Work, WorkStore } from './store';

export type Availability = 'text' | 'absent' | 'binary' | 'size-limit' | 'unknown';
export type FileState = { hash: string; rawHash: string; content: string | null; availability: Availability };
export type Snapshot = Record<string, FileState>;
export const excludedNames = ['.git', '.data', '.reference', '.tools', '.logs', '.idea-trash', 'node_modules', 'dist', '.nuxt', '.output'];
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
export const snapshotRevision = (files: Snapshot) => digest(JSON.stringify(Object.entries(files).map(([path, f]) => [path, f.hash]).sort()));
const rawRevision = (files: Snapshot) => digest(JSON.stringify(Object.entries(files).map(([path, f]) => [path, f.rawHash]).sort()));

/** Reads twice to reject a changing tree, rather than silently publishing a partial result. */
export function collectFiles(root: string): Snapshot {
  const scan = () => {
    const files: Snapshot = {};
    const data = resolve(process.env.DATA_DIR || '../.data');
    const visit = (dir: string, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = join(dir, entry.name), path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || excludedNames.includes(entry.name) || absolute === data || entry.name.endsWith('.tsbuildinfo')) continue;
        if (entry.isDirectory()) { visit(absolute, path); continue; }
        if (!entry.isFile()) continue;
        const before = statSync(absolute), bytes = readFileSync(absolute), after = statSync(absolute);
        if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.ino !== after.ino) throw new ConflictException('파일 수집 중 변경되었습니다. 다시 시도해 주세요');
        const availability = bytes.length >= 200000 ? 'size-limit' : bytes.includes(0) ? 'binary' : 'text';
        const content = availability === 'text' ? bytes.toString('utf8') : null;
        const normalized = /(^|\/)tasks\.md$/.test(path) && content !== null ? content.replace(/- \[[xX ]\]/g, '- [ ]') : bytes;
        files[path] = { hash: digest(normalized), rawHash: digest(bytes), content, availability };
      }
    };
    visit(root); return files;
  };
  const first = scan(), second = scan();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new ConflictException('파일 수집 중 변경되었습니다. 다시 시도해 주세요');
  return first;
}

function differences(before: Snapshot, after: Snapshot) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(path => before[path]?.hash !== after[path]?.hash).map(path => ({
    path, status: !before[path] ? 'added' : !after[path] ? 'removed' : 'modified',
    before: before[path]?.content ?? null, after: after[path]?.content ?? null,
    beforeAvailability: before[path] ? before[path].availability || (before[path].content === null ? 'unknown' : 'text') : 'absent',
    afterAvailability: after[path] ? after[path].availability || (after[path].content === null ? 'unknown' : 'text') : 'absent',
    beforeHash: before[path]?.rawHash ?? null, afterHash: after[path]?.rawHash ?? null,
  }));
}

export class FileResults {
  constructor(private store: WorkStore) {}
  private base(work: Work) { return this.store.records(work.id, 'isolated-baseline')[0]; }
  private planRevision(project: string, change: string) {
    const root = join(project, 'openspec', 'changes', change);
    if (!existsSync(root)) return null;
    const files = collectFiles(root);
    return digest(JSON.stringify(Object.entries(files).filter(([path]) => /^(proposal|design|tasks)\.md$/.test(path) || /^specs\/.+\.md$/.test(path)).map(([path, file]) => [path, file.hash]).sort()));
  }
  assertSourcePlan(work: Work) {
    const base = this.base(work), application = this.store.records(work.id, 'application')[0];
    const expected = application?.status === 'applied' ? application.sourcePlanRevision : base?.sourcePlanRevision;
    if (expected && expected !== this.planRevision(work.projectPath, work.changeName)) throw new ConflictException('원본 계획이 변경되었습니다. 업무 계획과 비교하고 재검토·복구해 주세요');
  }
  path(work: Work): string {
    const base = this.base(work);
    try {
      if (!base || !work.executionPath || base.executionPath !== work.executionPath) throw new Error();
      const path = String(work.executionPath);
      if (inside(resolve(work.projectPath), resolve(path)) || realpathSync(path) !== resolve(path) || !lstatSync(path).isDirectory()) throw new Error();
      const identity = JSON.parse(readFileSync(join(dirname(path), 'identity.json'), 'utf8'));
      if (identity.workId !== work.id || identity.projectPath !== work.projectPath) throw new Error();
      return path;
    } catch { throw new ConflictException('업무 전용 공간의 식별 정보가 없거나 달라 복구가 필요합니다'); }
  }
  prepare(work: Work, transition = false) {
    if (this.base(work)) { this.path(work); return; }
    if (this.store.records(work.id, 'baseline').length && !transition) throw new ConflictException('기존 공유 폴더 업무입니다. 격리 공간으로 명시적 전환이 필요합니다');
    const manager = resolve(process.env.WORKSPACE_ROOT || join(tmpdir(), 'openspec-workspaces'));
    mkdirSync(manager, { recursive: true });
    if (inside(realpathSync(work.projectPath), realpathSync(manager))) throw new ConflictException('업무 관리 폴더는 원본 프로젝트 밖이어야 합니다');
    const container = join(manager, `${digest(`${resolve(process.env.DATA_DIR || '../.data')}:${work.id}`)}-${randomUUID()}`);
    mkdirSync(container); // Never reuse a failed/foreign copy without explicit recovery.
    const path = join(container, 'project'), before = collectFiles(work.projectPath);
    const data = resolve(process.env.DATA_DIR || '../.data');
    cpSync(work.projectPath, path, { recursive: true, errorOnExist: true, force: false, filter: source => {
      const rel = relative(work.projectPath, source).split(sep);
      if (!rel[0]) return true;
      if (lstatSync(source).isSymbolicLink() || resolve(source) === data || rel.includes('.git') || rel.includes('.data') || rel.includes('.logs')) return false;
      // Dependencies and the project runtime are independent copies, never junctions/hardlinks.
      if (rel[0] === '.tools' && rel.length > 1 && rel[1] !== 'node-runtime') return false;
      return true;
    } });
    if (snapshotRevision(before) !== snapshotRevision(collectFiles(work.projectPath)) || JSON.stringify(before) !== JSON.stringify(collectFiles(path))) throw new ConflictException('복사 중 원본이 변경되었습니다. 업무 공간 복구가 필요합니다');
    writeFileSync(join(container, 'identity.json'), JSON.stringify({ workId: work.id, projectPath: work.projectPath }), { flag: 'wx' });
    work.executionPath = path;
    this.store.transaction(() => {
      this.store.record(`${work.id}:isolated-baseline`, work.id, 'isolated-baseline', { version: 1, policyVersion: 1, executionPath: path, startedAt: new Date().toISOString(), sourcePlanRevision: this.planRevision(work.projectPath, work.changeName), files: before });
      this.store.save(work);
    });
  }
  report(work: Work) {
    const saved = this.store.records(work.id, 'completed-changes')[0];
    if (['completed', 'archived'].includes(work.phase)) return saved?.report || this.unavailable();
    const base = this.base(work);
    if (!base) return this.unavailable();
    try {
      const files = collectFiles(this.path(work));
      const applied = this.store.records(work.id, 'application')[0];
      const application = applied?.status === 'applied' && applied.rawRevision !== rawRevision(files) ? 'not-applied' : applied?.status || 'not-applied';
      return { version: 1, policyVersion: 1, workId: work.id, source: 'current', isolated: true, startedAt: base.startedAt, endedAt: null,
        files: differences(base.files, files), revision: snapshotRevision(files), application, conflicts: applied?.conflicts || [], excluded: excludedNames };
    } catch (error: any) { return { ...this.unavailable(), error: error.message }; }
  }
  private unavailable() { return { source: 'unavailable', isolated: false, files: [], startedAt: null, endedAt: null, application: 'not-applied', excluded: excludedNames }; }
  apply(work: Work) {
    const path = this.path(work), files = collectFiles(path), base = this.base(work)!;
    const revision = snapshotRevision(files);
    let journal = this.store.records(work.id, 'application')[0];
    if (journal && journal.status !== 'applied' && (journal.revision !== revision || journal.rawRevision !== rawRevision(files))) throw new ConflictException('이전 원본 반영을 복구한 뒤 결과를 수정해 주세요');
    if (!journal || journal.status === 'applied') {
      const changes = differences(base.files, files);
      const lastApplied = journal?.status === 'applied' ? journal.entries : [];
      for (const entry of lastApplied) if (!changes.some(file => file.path === entry.path)) changes.push({ path: entry.path } as typeof changes[number]);
      // Progress-only checkbox edits are omitted from the review list but must reach OpenSpec before archive.
      const taskPath = `openspec/changes/${work.changeName}/tasks.md`;
      if (!changes.some(file => file.path === taskPath) && base.files[taskPath]?.rawHash !== files[taskPath]?.rawHash) changes.push({ path: taskPath } as typeof changes[number]);
      const entries = changes.map(file => {
        const original = within(work.projectPath, file.path);
        const old = existsSync(original) ? readFileSync(original) : null;
        const next = files[file.path] ? readFileSync(within(path, file.path)) : null;
        if ((next === null ? null : digest(next)) !== (files[file.path]?.rawHash ?? null)) throw new ConflictException('반영 준비 중 업무 결과가 변경되었습니다');
        const previous = lastApplied.find((entry: any) => entry.path === file.path);
        return { path: file.path, before: old?.toString('base64') ?? null, after: next?.toString('base64') ?? null,
          beforeHash: old === null ? null : digest(old), afterHash: next === null ? null : digest(next), baselineHash: previous ? previous.afterHash : base.files[file.path]?.rawHash ?? null };
      });
      journal = { version: 1, revision, rawRevision: rawRevision(files), status: 'applying', entries, updatedAt: new Date().toISOString() };
    }
    const conflicts = journal.entries.filter((e: any) => {
      const target = within(work.projectPath, e.path), hash = existsSync(target) ? digest(readFileSync(target)) : null;
      return hash !== e.baselineHash && hash !== e.afterHash && !(journal.status !== 'applied' && hash === e.beforeHash && e.beforeHash === e.baselineHash);
    }).map((e: any) => e.path);
    if (conflicts.length) {
      this.store.record(`${work.id}:application`, work.id, 'application', { ...journal, status: 'conflict', conflicts });
      throw new ConflictException({ message: '원본 반영 충돌이 있습니다', conflicts });
    }
    this.store.record(`${work.id}:application`, work.id, 'application', { ...journal, status: 'applying', conflicts: [] });
    // Persist backups before any file changes. A retry accepts only baseline or already applied bytes.
    for (const entry of journal.entries) {
      const target = within(work.projectPath, entry.path), now = existsSync(target) ? digest(readFileSync(target)) : null;
      if (now === entry.afterHash) continue;
      if (now !== entry.baselineHash) throw new ConflictException(`원본 반영 충돌: ${entry.path}`);
      mkdirSync(dirname(target), { recursive: true });
      if (entry.after === null) unlinkSync(target);
      else {
        const temp = entry.tempPath || join(dirname(target), `.work-${randomUUID()}.tmp`);
        entry.tempPath = temp;
        this.store.record(`${work.id}:application`, work.id, 'application', { ...journal, status: 'applying' });
        // The path was reserved in the durable journal before writing. Reuse completed temp bytes after restart.
        if (existsSync(temp) && (lstatSync(temp).isSymbolicLink() || digest(readFileSync(temp)) !== entry.afterHash)) throw new ConflictException(`반영 임시 파일 복구가 필요합니다: ${entry.path}`);
        if (!existsSync(temp)) writeFileSync(temp, Buffer.from(entry.after, 'base64'), { flag: 'wx' });
        try {
          const latest = existsSync(target) ? digest(readFileSync(target)) : null;
          if (latest !== entry.baselineHash) throw new ConflictException(`원본 반영 충돌: ${entry.path}`);
          renameSync(temp, target);
        } finally { if (existsSync(temp)) unlinkSync(temp); }
      }
    }
    if (rawRevision(collectFiles(path)) !== journal.rawRevision) throw new ConflictException('반영 중 업무 결과가 변경되었습니다');
    this.store.record(`${work.id}:application`, work.id, 'application', { ...journal, status: 'applied', sourcePlanRevision: this.planRevision(work.projectPath, work.changeName), conflicts: [], updatedAt: new Date().toISOString() });
    return this.report(work);
  }
  freeze(work: Work, files = collectFiles(this.path(work))) {
    const application = this.store.records(work.id, 'application')[0], revision = snapshotRevision(files);
    if (application?.status !== 'applied' || application.revision !== revision || application.rawRevision !== rawRevision(files)) throw new ConflictException('최신 결과를 원본에 별도로 반영해 주세요');
    for (const entry of application.entries) {
      const target = within(work.projectPath, entry.path);
      if ((existsSync(target) ? digest(readFileSync(target)) : null) !== entry.afterHash) throw new ConflictException(`반영 이후 원본이 변경되었습니다: ${entry.path}`);
    }
    const base = this.base(work)!;
    const report = { version: 1, policyVersion: 1, workId: work.id, source: 'completed', isolated: true, startedAt: base.startedAt,
      endedAt: new Date().toISOString(), revision, files: differences(base.files, files), application: 'applied', excluded: excludedNames };
    const completed = { ...work, phase: 'completed' };
    this.store.transaction(() => {
      this.store.record(`${work.id}:completed-changes`, work.id, 'completed-changes', { report });
      this.store.save(completed);
    });
    work.phase = 'completed'; return report;
  }
}
