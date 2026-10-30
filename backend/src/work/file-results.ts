import { ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, openSync, fstatSync, closeSync, opendirSync, readSync, type Dirent } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { within } from '../files';
import { Work, WorkStore } from './store';
import { CompletedResults, type CompletedIntegration } from './completed-results';
import { WorkspaceService } from './workspace.service';
import type { WorkspaceSettingsService } from './workspace-settings.service';
import { readGitSync } from '../projects/git-runner';
import { readGitBlobsSync } from '../projects/git-blobs';
import { collectWorkspaceDocuments } from './workspace-documents';
import { managedPrivatePath, workspaceResourcePath } from './workspace-file-policy';
export { localSecretPath } from './workspace-file-policy';

export type Availability = 'text' | 'absent' | 'binary' | 'size-limit' | 'unknown';
export type FileState = { hash: string; rawHash: string; content: string | null; availability: Availability; mode?: string };
export type Snapshot = Record<string, FileState>;
export const excludedNames = ['.git', '.data', '.reference', '.tools', '.logs', '.idea-trash', 'node_modules', 'dist', '.nuxt', '.output'];
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
export const snapshotRevision = (files: Snapshot) => digest(JSON.stringify(Object.entries(files).map(([path, f]) => f.mode ? [path, f.hash, f.mode] : [path, f.hash]).sort()));
const rawRevision = (files: Snapshot) => digest(JSON.stringify(Object.entries(files).map(([path, f]) => f.mode ? [path, f.rawHash, f.mode] : [path, f.rawHash]).sort()));

/** Reads twice to reject a changing tree, rather than silently publishing a partial result. */
const workspaceExcluded = (work: Work, path: string) => path.split('/').some(part => excludedNames.includes(process.platform === 'win32' ? part.toLowerCase() : part)) || workspaceResourcePath(work, path);
export function collectFiles(root: string, exclude: (path: string) => boolean = () => false, strictOwnership = false): Snapshot {
  const scan = () => {
    const files: Snapshot = Object.create(null), started = Date.now();
    const data = resolve(process.env.DATA_DIR || '../.data');
    let entries = 1, total = 0;
    const checkTime = () => { if (Date.now() - started > 2000) throw new ConflictException('소스 파일 검사 시간 한도를 초과했습니다. 범위를 정리한 뒤 다시 확인해 주세요'); };
    const visit = (dir: string, prefix = '') => {
      const directory = opendirSync(dir), children: Dirent[] = [];
      try { let entry: Dirent | null; while ((entry = directory.readSync())) { if (++entries > 10000) throw new ConflictException('소스 파일 수 한도를 초과했습니다'); checkTime(); children.push(entry); } }
      finally { directory.closeSync(); }
      for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
        checkTime();
        const absolute = join(dir, entry.name), path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (excludedNames.includes(entry.name) || absolute === data || entry.name.endsWith('.tsbuildinfo') || exclude(path)) continue;
        if (entry.isSymbolicLink()) { if (strictOwnership) throw new ConflictException('링크가 포함된 업무 소스는 실제 결과를 확인할 수 없습니다. 독립 파일로 복구해 주세요.'); continue; }
        if (entry.isDirectory()) {
          if (strictOwnership && existsSync(join(absolute, '.git'))) throw new ConflictException('중첩 Git 경계의 소스는 지원하지 않습니다.');
          visit(absolute, path); continue;
        }
        if (!entry.isFile()) continue;
        const before = lstatSync(absolute);
        if (!before.isFile() || before.isSymbolicLink() || strictOwnership && before.nlink !== 1) throw new ConflictException('소스 파일의 실제 소유를 확인할 수 없습니다');
        if (before.size > 128 * 1024 ** 2 || (total += before.size) > 128 * 1024 ** 2) throw new ConflictException('소스 파일 읽기 한도를 초과했습니다. 원본을 보존합니다');
        const descriptor = openSync(absolute, 'r'), raw = createHash('sha256'), parts: Buffer[] = [];
        let size = 0;
        try {
          const opened = fstatSync(descriptor);
          if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || strictOwnership && opened.nlink !== 1) throw new ConflictException('소스 소유가 읽기 전에 변경되었습니다');
          const buffer = Buffer.allocUnsafe(65536); let count: number;
          while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
            checkTime(); size += count; if (size > before.size) throw new ConflictException('소스 파일이 읽는 중 커졌습니다');
            const chunk = buffer.subarray(0, count); raw.update(chunk); if (before.size < 200000) parts.push(Buffer.from(chunk));
          }
          if (size !== before.size) throw new ConflictException('소스 파일 크기가 읽는 중 변경되었습니다');
        } finally { closeSync(descriptor); }
        const after = lstatSync(absolute);
        if (!after.isFile() || after.isSymbolicLink() || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size || before.ino !== after.ino || before.dev !== after.dev || strictOwnership && (after.nlink !== 1 || after.mode !== before.mode)) throw new ConflictException('파일 수집 중 변경되었습니다. 다시 시도해 주세요');
        const bytes = size < 200000 ? Buffer.concat(parts, size) : null, rawHash = raw.digest('hex');
        const availability: Availability = bytes === null ? 'size-limit' : bytes.includes(0) ? 'binary' : 'text';
        const content = availability === 'text' ? bytes!.toString('utf8') : null;
        files[path] = { hash: /(^|\/)tasks\.md$/.test(path) && content !== null ? digest(content.replace(/- \[[xX ]\]/g, '- [ ]')) : rawHash, rawHash, content, availability };
      }
    };
    visit(root); return files;
  };
  const first = scan(), second = scan();
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new ConflictException('파일 수집 중 변경되었습니다. 다시 시도해 주세요');
  return first;
}

export function differences(before: Snapshot, after: Snapshot) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(path => {
    const previous = Object.hasOwn(before, path) ? before[path] : undefined, current = Object.hasOwn(after, path) ? after[path] : undefined;
    if (previous?.hash === current?.hash && previous?.mode === current?.mode) return [];
    return [{ path, status: !previous ? 'added' : !current ? 'removed' : 'modified', before: previous?.content ?? null, after: current?.content ?? null,
      beforeAvailability: previous ? previous.availability || (previous.content === null ? 'unknown' : 'text') : 'absent',
      afterAvailability: current ? current.availability || (current.content === null ? 'unknown' : 'text') : 'absent',
      beforeHash: previous?.rawHash ?? null, afterHash: current?.rawHash ?? null,
      ...(previous?.mode || current?.mode ? { beforeMode: previous?.mode ?? null, afterMode: current?.mode ?? null } : {}),
    }];
  });
}


export class FileResults {
  constructor(private store: WorkStore, private spaces = new WorkspaceService(store)) {}
  snapshot(work: Work, root = this.path(work)) {
    const files = collectFiles(root, work.workspace ? path => workspaceExcluded(work, path) : undefined, !!work.workspace);
    if (work.workspace?.kind === 'git-worktree') {
      const modes = new Map<string, string>();
      const index = readGitSync(root, ['-c', 'core.fsmonitor=false', 'ls-files', '--stage', '-z']);
      for (const entry of index.split('\0')) {
        const match = /^(\d{6}) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(entry);
        if (!match) continue;
        if (!workspaceExcluded(work, match[3]) && (match[2] !== '0' || !['100644', '100755'].includes(match[1]))) throw new ConflictException('미병합 index 또는 지원하지 않는 Git 파일 형식입니다. 경계를 확인해 주세요.');
        modes.set(match[3], match[1]);
      }
      // Only mode is needed here. Git diff can execute clean filters while reading
      // worktree bytes, even with external diff/textconv disabled.
      const filemode = readGitSync(root, ['-c', 'core.fsmonitor=false', 'config', '--bool', '--default=true', '--get', 'core.filemode']).trim() !== 'false';
      for (const [path, file] of Object.entries(files)) {
        const diskMode = lstatSync(join(root, path)).mode & 0o111 ? '100755' : '100644';
        file.mode = filemode ? diskMode : modes.get(path) ?? diskMode;
      }
      if (readGitSync(root, ['-c', 'core.fsmonitor=false', 'ls-files', '--stage', '-z']) !== index) throw new ConflictException('업무 Git 결과 수집 중 index 또는 mode가 변경되었습니다. 다시 조회해 주세요.');
    }
    return files;
  }
  private base(work: Work) { return this.store.records(work.id, 'isolated-baseline')[0]; }
  private planRevision(project: string, change: string) {
    const root = join(project, 'openspec', 'changes', change);
    if (!existsSync(root)) return null;
    const files = collectFiles(root);
    return digest(JSON.stringify(Object.entries(files).filter(([path]) => /^(proposal|design|tasks)\.md$/.test(path) || /^specs\/.+\.md$/.test(path)).map(([path, file]) => [path, file.hash]).sort()));
  }
  assertSourcePlan(work: Work) {
    if (work.workspace?.kind === 'git-worktree') {
      if (work.workspace.sourcePlanRevision !== collectWorkspaceDocuments(work.projectPath, work.changeName).planRevision) throw new ConflictException('원본 계획이 변경되었습니다. 업무 계획과 비교하고 재검토·복구해 주세요');
      return;
    }
    const base = this.base(work), application = this.store.records(work.id, 'application')[0];
    const expected = application?.status === 'applied' ? application.sourcePlanRevision : base?.sourcePlanRevision;
    if (expected && expected !== this.planRevision(work.projectPath, work.changeName)) throw new ConflictException('원본 계획이 변경되었습니다. 업무 계획과 비교하고 재검토·복구해 주세요');
  }
  path(work: Work): string {
    return this.spaces.path(work);
  }
  prepare(work: Work, transition = false) {
    if (work.workspace?.kind === 'git-worktree') { this.path(work); return; }
    if (this.base(work)) { this.path(work); return; }
    if (work.workspace !== undefined || this.store.records(work.id, 'workspace-preparation').some(record => record.status === 'failed')) throw new ConflictException('기존 준비 공간과 잔여 파일을 확인해 복구해 주세요. 새 경로로 자동 재시도하지 않습니다.');
    if (process.env.OPENSPEC_WORKTREE_EXPERIMENTAL === '1' && !transition) throw new ConflictException('신규 업무 공간 준비 API에서 Git 기준과 복사 방식을 먼저 확인해 주세요.');
    if (this.store.records(work.id, 'baseline').length && !transition) throw new ConflictException('기존 공유 폴더 업무입니다. 격리 공간으로 명시적 전환이 필요합니다');
    const manager = resolve(process.env.WORKSPACE_ROOT || join(tmpdir(), 'openspec-workspaces'));
    return this.spaces.prepareStage(work, manager, 'create', () => this.prepareCopy(work, manager));
  }
  prepareManagedCopy(work: Work, settings: WorkspaceSettingsService) {
    this.spaces.reserve(work, settings, 'copy');
    return this.spaces.prepareStage(work, work.executionPath!, 'create', () => this.prepareCopy(work, work.workspace!.managedPath, true));
  }
  private prepareCopy(work: Work, manager: string, managed = false) {
    this.spaces.prepareStage(work, manager, 'create', () => mkdirSync(manager, { recursive: true }));
    if (inside(realpathSync(work.projectPath), realpathSync(manager))) throw new ConflictException('업무 관리 폴더는 원본 프로젝트 밖이어야 합니다');
    const container = managed ? dirname(work.executionPath!) : join(manager, `${digest(`${resolve(process.env.DATA_DIR || '../.data')}:${work.id}`)}-${randomUUID()}`);
    if (managed) mkdirSync(dirname(container), { recursive: true });
    this.spaces.prepareStage(work, container, 'create', () => mkdirSync(container)); // Never reuse a failed/foreign copy without explicit recovery.
    const path = join(container, 'project'), before = this.snapshot(work, work.projectPath);
    const data = resolve(process.env.DATA_DIR || '../.data');
    this.spaces.prepareStage(work, path, 'copy', () => cpSync(work.projectPath, path, { recursive: true, errorOnExist: true, force: false, filter: source => {
      const rel = relative(work.projectPath, source).split(sep);
      if (!rel[0]) return true;
      if (managed && managedPrivatePath(rel.join('/'))) return false;
      if (lstatSync(source).isSymbolicLink() || resolve(source) === data || rel.includes('.git') || rel.includes('.data') || rel.includes('.logs')) return false;
      // Dependencies and the project runtime are independent copies, never junctions/hardlinks.
      if (rel[0] === '.tools' && rel.length > 1 && rel[1] !== 'node-runtime') return false;
      return true;
    } }));
    if (snapshotRevision(before) !== snapshotRevision(this.snapshot(work, work.projectPath)) || JSON.stringify(before) !== JSON.stringify(this.snapshot(work, path))) throw new ConflictException('복사 중 원본이 변경되었습니다. 업무 공간 복구가 필요합니다');
    writeFileSync(join(container, 'identity.json'), JSON.stringify({ ...(managed ? { schemaVersion: 1, ...work.workspace } : {}), workId: work.id, projectPath: work.projectPath }), { flag: 'wx' });
    work.executionPath = path;
    this.store.transaction(() => {
      this.store.record(`${work.id}:isolated-baseline`, work.id, 'isolated-baseline', { version: 1, policyVersion: 1, executionPath: path, startedAt: new Date().toISOString(), sourcePlanRevision: this.planRevision(work.projectPath, work.changeName), files: before });
      if (managed) work.workspace!.status = 'ready';
      this.store.save(work);
    });
  }
  report(work: Work) {
    if (['completed', 'archived'].includes(work.phase)) { const retained = new CompletedResults(this.store).header(work.id); if (retained) return retained; }
    const saved = this.store.records(work.id, 'completed-changes')[0];
    if (['completed', 'archived'].includes(work.phase)) return saved?.report || this.unavailable();
    if (work.workspace?.kind === 'git-worktree') {
      try { return this.gitReport(work); } catch (error: any) { return { ...this.unavailable(), kind: 'git-worktree', error: error.message }; }
    }
    const base = this.base(work);
    if (!base) return this.unavailable();
    try {
      const files = this.snapshot(work, this.path(work));
      const applied = this.store.records(work.id, 'application')[0];
      const application = applied?.status === 'applied' && applied.rawRevision !== rawRevision(files) ? 'not-applied' : applied?.status || 'not-applied';
      return { version: 1, policyVersion: 1, workId: work.id, source: 'current', isolated: true, startedAt: base.startedAt, endedAt: null,
        files: differences(base.files, files), revision: snapshotRevision(files), application, conflicts: applied?.conflicts || [], excluded: excludedNames };
    } catch (error: any) { return { ...this.unavailable(), error: error.message }; }
  }
  private gitReport(work: Work) {
    const root = this.path(work), baseline = work.workspace!.workspaceBaselineCommit!;
    const status = () => readGitSync(root, ['rev-parse', 'HEAD']) + readGitSync(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const files = this.snapshot(work, root), started = status(), before: Snapshot = {}, after: Snapshot = {};
    const metadata = new Map<string, { blob: string; size: number; mode: string }>();
    for (const row of readGitSync(root, ['ls-tree', '-r', '-l', '-z', baseline, '--']).split('\0').filter(Boolean)) {
      const match = /^(\d{6}) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(row); if (match) metadata.set(match[4], { mode: match[1], blob: match[2], size: Number(match[3]) });
    }
    const paths = new Set([...readGitSync(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', baseline, '--']).split('\0'), ...readGitSync(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(path => path && !workspaceExcluded(work, path)));
    if (paths.size > 10000) throw new ConflictException('업무 변경 파일 조회 한도를 초과했습니다.');
    const blobs = readGitBlobsSync(root, [...paths].flatMap(path => { const old = metadata.get(path); return old && old.size < 200000 ? [old] : []; }), (bytes): FileState => {
      const binary = bytes.includes(0), hash = digest(bytes);
      return { hash, rawHash: hash, content: binary ? null : bytes.toString('utf8'), availability: binary ? 'binary' : 'text' };
    });
    const normalized = (path: string, file: FileState): FileState => {
      if (file.content === null) return file;
      let content = file.content.replaceAll('\r\n', '\n'); if (/(^|\/)tasks\.md$/.test(path)) content = content.replace(/- \[[xX ]\]/g, '- [ ]');
      return { ...file, hash: digest(content) };
    };
    for (const path of paths) {
      const old = metadata.get(path);
      if (old) {
        if (old.size >= 200000) before[path] = { hash: `git:${old.blob}`, rawHash: `git:${old.blob}`, content: null, availability: 'size-limit', mode: old.mode };
        else {
          before[path] = normalized(path, { ...blobs.get(old.blob)!, mode: old.mode });
        }
      }
      if (files[path]) after[path] = normalized(path, files[path]);
    }
    if (status() !== started || rawRevision(this.snapshot(work, root)) !== rawRevision(files)) throw new ConflictException('업무 Git 결과 수집 중 변경되었습니다. 다시 조회해 주세요.');
    return { version: 1, policyVersion: 1, kind: 'git-worktree', workId: work.id, source: 'current', isolated: true, startedAt: this.store.records(work.id, 'workspace-creation')[0]?.createdAt ?? null, endedAt: null, files: differences(before, after), revision: snapshotRevision(files), application: 'not-applied', conflicts: [], excluded: [...excludedNames, ...(work.workspace!.localOnlyPaths ?? [])], baseCommit: work.workspace!.baseCommit, workspaceBaselineCommit: baseline };
  }
  private unavailable() { return { source: 'unavailable', isolated: false, files: [], startedAt: null, endedAt: null, application: 'not-applied', excluded: excludedNames }; }
  apply(work: Work) {
    if (work.workspace?.kind === 'git-worktree') throw new ConflictException('Git 업무는 통합 후보 검증과 별도 확정이 필요합니다.');
    const path = this.path(work), files = this.snapshot(work, path), base = this.base(work)!;
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
    if (rawRevision(this.snapshot(work, path)) !== journal.rawRevision) throw new ConflictException('반영 중 업무 결과가 변경되었습니다');
    this.store.record(`${work.id}:application`, work.id, 'application', { ...journal, status: 'applied', sourcePlanRevision: this.planRevision(work.projectPath, work.changeName), conflicts: [], updatedAt: new Date().toISOString() });
    return this.report(work);
  }
  freeze(work: Work, files?: Snapshot, git?: GitCompletionCapture) {
    if (work.workspace?.kind === 'git-worktree') {
      if (!git) throw new ConflictException('Git 완료는 실제 반영과 고정 검증 근거 확인이 필요합니다');
      this.store.transaction(() => {
        git.assertUnchanged(); const retained = new CompletedResults(this.store).capture(work, git.report, git.refs, git.integration);
        git.assertUnchanged();
        this.store.record(`${work.id}:completed-changes`, work.id, 'completed-changes', { report: retained });
        this.store.save({ ...work, phase: 'completed' });
      });
      work.phase = 'completed'; return git.report;
    }
    files ??= this.snapshot(work, this.path(work));
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
      const retained = new CompletedResults(this.store).capture(work, report);
      this.store.record(`${work.id}:completed-changes`, work.id, 'completed-changes', { report: retained });
      this.store.save(completed);
    });
    work.phase = 'completed'; return report;
  }
}
export type GitCompletionCapture = { report: any; refs: { id: string; kind: 'verification' | 'candidate-verification' | 'browser-verification' }[]; integration: CompletedIntegration; assertUnchanged: () => void };
