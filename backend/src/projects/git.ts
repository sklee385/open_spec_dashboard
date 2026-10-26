import { ProjectFiles } from './files';
import { gitCommonDirectory } from './git-metadata';
import { readFile, realpath, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { runGit, GitError, RunnerOptions, scrub } from './git-runner';
import { digest, OperationStore, OperationBody, GitOperation } from './git-operations';
export type { GitOperation, OperationBody } from './git-operations';
export interface GitEntry {
    path: string;
    originalPath?: string;
    index: string;
    worktree: string;
    untracked: boolean;
    conflicted: boolean;
}
export interface GitStatus {
    available: boolean;
    reason?: string;
    root?: string;
    branch: string | null;
    head: string | null;
    upstream: string | null;
    remote?: string | null;
    ahead: number;
    behind: number;
    entries: GitEntry[];
    token: string;
    progress: null | {
        kind: 'merge' | 'rebase';
        owned: boolean;
        operationId?: string;
    };
    remotes: string[];
    destinations?: string[];
    blocked?: string;
    protectedIndex?: boolean;
    hiddenChanges?: number;
    outgoing?: {
        hash: string;
        message: string;
    }[];
}
interface Options extends RunnerOptions {
    dataDir?: string;
}
type GitBytes = Buffer & {
    actualSize?: number;
    sourceVersion?: string;
};
export class ProjectGit {
    private files = new ProjectFiles();
    private store: OperationStore;
    private active = new Set<string>();
    private pending = new Set<Promise<void>>();
    private closing = false;
    constructor(private options: Options = {}) {
        this.store = new OperationStore(path.join(options.dataDir ?? process.env.DATA_DIR ?? path.resolve('../.data'), 'project-git-operations'));
    }
    private run(root: string, args: string[], optional = false) {
        return runGit(root, args, this.options, optional);
    }
    private async text(root: string, args: string[], optional = false) {
        return (await this.run(root, args, optional)).toString('utf8').trim();
    }
    private async canonical(root: string) {
        return realpath(root);
    }
    private destinationLabel(value: string) {
        try {
            const url = new URL(value);
            if (!['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol))
                return '설정된 원격';
            return `${url.protocol}//${url.host}/${url.pathname.split('/').filter(Boolean).at(-1) ?? ''}`;
        }
        catch {
            const scp = /^(?:[^@\s]+@)?([^:\s]+):([^\s]+)$/.exec(value);
            if (scp && !/^[a-z]:[\\/]/i.test(value))
                return scp[1] + ':' + scp[2].split('/').at(-1);
            if (value.includes('::'))
                return '설정된 원격';
            return 'local:' + path.basename(value);
        }
    }
    private async commonDirectory(root: string) {
        try { return path.resolve(root, await this.text(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], true)); }
        catch (error) {
            if (!(error instanceof GitError) || error.status !== 503) throw error;
            return gitCommonDirectory(root) || root;
        }
    }
    async assertReady(root: string) {
        root = await this.canonical(root);
        const commonDir = await this.commonDirectory(root);
        const uncertain = (await this.store.all()).find(record => !record.reviewedAt && record.state === 'uncertain' && (record.root === root || record.commonDir === commonDir));
        if (uncertain)
            throw new GitError('결과가 불확실한 Git 작업을 먼저 확인하세요. 작업 ID: ' + uncertain.id, 409);
    }
    private size(bytes: GitBytes | null) {
        return bytes?.actualSize ?? bytes?.length ?? 0;
    }
    private oversized(size: number, version: string): GitBytes {
        const bytes: GitBytes = Buffer.alloc(0);
        bytes.actualSize = size;
        bytes.sourceVersion = version;
        return bytes;
    }
    private async objectBytes(root: string, oid: string): Promise<GitBytes> {
        const size = Number(await this.text(root, ['cat-file', '-s', oid]));
        if (size > 1024 * 1024)
            return this.oversized(size, oid);
        return this.run(root, ['cat-file', 'blob', oid]);
    }
    private async worktreeBytes(root: string, name: string): Promise<GitBytes> {
        const absolute = path.join(root, name);
        const physical = await realpath(absolute);
        if ((process.platform === 'win32' ? physical.toLowerCase() !== absolute.toLowerCase() : physical !== absolute))
            throw new GitError('파일 경로가 링크로 교체되었습니다.', 409);
        const initial = await lstat(absolute);
        if (!initial.isFile() || initial.isSymbolicLink())
            throw new GitError('일반 파일만 읽을 수 있습니다.');
        const handle = await open(absolute, 'r');
        try {
            const stat = await handle.stat();
            if (stat.ino !== initial.ino || stat.dev !== initial.dev)
                throw new GitError('파일이 교체되었습니다.', 409);
            const bytes = Buffer.alloc(Math.min(stat.size, 1024 * 1024 + 1));
            let offset = 0;
            while (offset < bytes.length) {
                const result = await handle.read(bytes, offset, bytes.length - offset, offset);
                if (!result.bytesRead)
                    break;
                offset += result.bytesRead;
            }
            const after = await handle.stat();
            const current = await lstat(absolute);
            const finalPhysical = await realpath(absolute);
            if (physical !== finalPhysical)
                throw new GitError('읽는 동안 파일 경로가 변경되었습니다.', 409);
            if (offset !== bytes.length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || current.ino !== after.ino || current.dev !== after.dev || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs || current.isSymbolicLink())
                throw new GitError('읽는 동안 파일이 변경되었습니다.', 409);
            if (stat.size > 1024 * 1024)
                return this.oversized(stat.size, digest(Buffer.concat([bytes, Buffer.from(JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]))])));
            return bytes;
        }
        finally {
            await handle.close();
        }
    }
    private validPath(value: unknown): asserts value is string {
        if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || value.split('/').some(s => s === '..' || s === '.' || !s) || /^[a-z]:/i.test(value) || value.split('/').some(s => s.toLowerCase() === '.git'))
            throw new GitError('잘못된 상대 파일 경로입니다.');
    }
    private async safePath(root: string, p: string) {
        this.validPath(p);
        this.files.validate(root, p, { missing: true });
        let current = root;
        for (const part of p.split('/')) {
            current = path.join(current, part);
            try {
                const st = await lstat(current);
                if (st.isSymbolicLink())
                    throw new GitError('링크 경로는 지원하지 않습니다.');
                if (current !== path.join(root, p) && st.isDirectory()) {
                    try {
                        await lstat(path.join(current, '.git'));
                        throw new GitError('중첩 저장소 경로는 지원하지 않습니다.');
                    }
                    catch (e) {
                        if (e instanceof GitError)
                            throw e;
                    }
                }
            }
            catch (e: any) {
                if (e.code === 'ENOENT')
                    break;
                throw e;
            }
        }
    }
    private async blob(root: string, rev: string, p: string) {
        await this.safePath(root, p);
        const listing = await this.run(root, ['ls-tree', '-z', rev, '--', p], true);
        if (!listing.length)
            return null;
        const record = listing.toString().split('\0')[0], meta = record.split('\t')[0].split(' ');
        if (meta[0] === '120000' || meta[1] !== 'blob')
            throw new GitError('링크 또는 하위 저장소 내용은 지원하지 않습니다.');
        return this.objectBytes(root, meta[2]);
    }
    private async indexBlob(root: string, p: string) {
        await this.safePath(root, p);
        const listing = await this.run(root, ['ls-files', '--stage', '-z', '--', p]);
        const entry = listing.toString().split('\0').find(s => s.split('\t')[1] === p && s.split('\t')[0].endsWith(' 0'));
        if (!entry)
            return null;
        const [mode, oid] = entry.split(' ');
        if (mode === '120000' || mode === '160000')
            throw new GitError('링크 또는 하위 저장소 내용은 지원하지 않습니다.');
        return this.objectBytes(root, oid);
    }
    private decode(buffer: GitBytes | null): {
        content: string | null;
        reason?: string;
        version?: string;
    } {
        if (buffer === null)
            return { content: null };
        const version = buffer.sourceVersion ?? digest(buffer);
        if (this.size(buffer) > 1024 * 1024)
            return { content: null, reason: '파일 크기 제한(1 MiB)을 초과했습니다.', version };
        if (buffer.includes(0))
            return { content: null, reason: '바이너리 파일입니다.', version };
        try {
            return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer), version };
        }
        catch {
            return { content: null, reason: 'UTF-8 텍스트가 아닙니다.', version };
        }
    }
    private async progressData(root: string) {
        const gitDir = await this.text(root, ['rev-parse', '--absolute-git-dir']);
        for (const [name, kind] of [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge']] as const) {
            try {
                const p = path.join(gitDir, name), st = await lstat(p);
                const marker = st.isDirectory() ? await readFile(path.join(p, 'orig-head')) : await readFile(p);
                return { kind, fingerprint: digest(Buffer.concat([Buffer.from(name + '\0' + st.birthtimeMs + '\0' + st.ino + '\0'), marker])) };
            }
            catch {
            }
        }
        return null;
    }
    async status(root: string): Promise<GitStatus> {
        root = await this.canonical(root);
        const empty: GitStatus = { available: false, branch: null, head: null, upstream: null, ahead: 0, behind: 0, entries: [], token: '', progress: null, remotes: [] };
        let top: string;
        try {
            top = await this.text(root, ['rev-parse', '--show-toplevel']);
        }
        catch (e) {
            return { ...empty, reason: (e as Error).message };
        }
        top = await realpath(top);
        const raw = await this.run(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']);
        const entries: GitEntry[] = [];
        let branch: string | null = null, head: string | null = null, upstream: string | null = null, ahead = 0, behind = 0;
        const parts = raw.toString('utf8').split('\0');
        for (let i = 0; i < parts.length; i++) {
            const line = parts[i];
            if (line.startsWith('# branch.oid ')) {
                const oid = line.slice(13);
                head = oid === '(initial)' ? null : oid;
            }
            else if (line.startsWith('# branch.head ')) {
                const b = line.slice(14);
                branch = b === '(detached)' ? null : b;
            }
            else if (line.startsWith('# branch.upstream '))
                upstream = line.slice(18);
            else if (line.startsWith('# branch.ab ')) {
                const m = line.match(/\+(\d+) -(\d+)/);
                if (m) {
                    ahead = +m[1];
                    behind = +m[2];
                }
            }
            else if (line[0] === '?')
                entries.push({ path: line.slice(2), index: '?', worktree: '?', untracked: true, conflicted: false });
            else if (['1', '2', 'u'].includes(line[0])) {
                const count = line[0] === '1' ? 8 : line[0] === '2' ? 9 : 10;
                let at = 0;
                for (let j = 0; j < count; j++)
                    at = line.indexOf(' ', at) + 1;
                const xy = line.split(' ')[1];
                entries.push({ path: line.slice(at), ...(line[0] === '2' ? { originalPath: parts[++i] } : {}), index: xy[0], worktree: xy[1], untracked: false, conflicted: line[0] === 'u' });
            }
        }
        const remotes = (await this.text(root, ['remote'])).split('\n').filter(Boolean);
        const index = await this.run(root, ['ls-files', '--stage', '-z']);
        const contentHashes: string[] = [];
        const guard = this.files.validationScope(root);
        const visible: GitEntry[] = [];
        let protectedIndex = false;
        for (const e of entries) {
            try {
                guard(e.path, { missing: true });
                if (e.originalPath)
                    guard(e.originalPath, { missing: true });
                visible.push(e);
            }
            catch {
                if (e.index !== '.' && !e.untracked)
                    protectedIndex = true;
                continue;
            }
            try {
                contentHashes.push(e.path + ':' + this.decode(await this.worktreeBytes(root, e.path)).version);
            }
            catch {
                contentHashes.push(e.path + ':missing-or-protected');
            }
        }
        let uncertainBlock: string | undefined;
        try {
            await this.assertReady(root);
        }
        catch (error) {
            uncertainBlock = (error as Error).message;
        }
        const progress = await this.progressData(root);
        let owned: GitOperation | undefined;
        if (progress)
            owned = (await this.store.all()).filter(r => r.root === root && r.progressKind === progress.kind && r.progressFingerprint === progress.fingerprint && ['conflicted', 'awaiting-continue'].includes(r.state)).at(-1);
        const remote = branch ? await this.text(root, ['config', '--get', `branch.${branch}.remote`], true) : null;
        const destinations = remote ? (await this.text(root, ['remote', 'get-url', '--push', '--all', '--', remote], true)).split('\n').filter(Boolean).map(value => this.destinationLabel(value)) : [];
        const outgoing = upstream && head ? (await this.text(root, ['log', '--format=%H%x00%s', `${upstream}..HEAD`], true)).split('\n').filter(Boolean).map(l => {
            const [hash, message] = l.split('\0');
            return { hash, message };
        }) : [];
        return { available: true, root: top, branch, head, upstream, remote: remote || null, ahead, behind, entries: visible, remotes, destinations, outgoing, protectedIndex, hiddenChanges: entries.length - visible.length, token: digest(Buffer.concat([raw, index, await this.run(root, ['config', '--null', '--get-regexp', '^(branch|remote|pull|url)[.]'], true), Buffer.from(JSON.stringify([contentHashes, remote, remotes, progress, upstream ? await this.text(root, ['rev-parse', '--verify', upstream], true) : null]))])), progress: progress ? { kind: progress.kind, owned: !!owned, ...(owned ? { operationId: owned.id } : {}) } : null, ...(uncertainBlock ? { blocked: uncertainBlock } : {}), ...(top.toLowerCase() !== root.toLowerCase() ? { blocked: '프로젝트 루트와 Git 저장소 루트가 다릅니다.' } : {}) };
    }
    async branches(root: string) {
        return { branches: (await this.text(root, ['for-each-ref', '--format=%(refname:short)%00%(HEAD)', 'refs/heads'])).split('\n').filter(Boolean).map(l => {
                const [name, current] = l.split('\0');
                return { name, current: current === '*' };
            }) };
    }
    private async hash(root: string, hash: string) {
        if (!/^[a-f0-9]{7,64}$/i.test(hash))
            throw new GitError('잘못된 커밋 해시입니다.');
        const verified = await this.text(root, ['rev-parse', '--verify', `${hash}^{commit}`], true);
        if (!verified)
            throw new GitError('커밋을 찾을 수 없습니다.', 404);
        return verified;
    }
    async log(root: string, cursor?: string) {
        const status = await this.status(root);
        if (!status.head)
            return { commits: [], nextCursor: null };
        let skip = 0, anchor = status.head;
        if (cursor) {
            const parts = /^([a-f0-9]{40,64}):(\d{1,8})$/.exec(cursor);
            if (!parts)
                throw new GitError('잘못된 이력 커서입니다.');
            anchor = await this.hash(root, parts[1]);
            skip = +parts[2];
        }
        const out = await this.run(root, ['log', '-51', `--skip=${skip}`, '--format=%H%x00%an%x00%aI%x00%B%x00', anchor]);
        const fields = out.toString().split('\0');
        const commits = [];
        for (let i = 0; i + 3 < fields.length; i += 4)
            commits.push({ hash: fields[i].trim(), author: fields[i + 1], date: fields[i + 2], message: fields[i + 3].trimEnd() });
        return { commits: commits.slice(0, 50), nextCursor: commits.length > 50 ? `${anchor}:${skip + 50}` : null };
    }
    async commit(root: string, hash: string) {
        hash = await this.hash(root, hash);
        const meta = (await this.run(root, ['show', '-s', '--format=%H%x00%an%x00%aI%x00%B%x00%P', hash])).toString().split('\0');
        const parents = meta[4].trim().split(' ').filter(Boolean), base = parents[0] ?? null;
        const out = await this.run(root, ['diff-tree', '--root', '--no-commit-id', '-r', '-M', '--name-status', '-z', ...(base ? [base, hash] : [hash])]);
        const fields = out.toString().split('\0'), files: {
            path: string;
            status: string;
            originalPath?: string;
        }[] = [];
        for (let i = 0; i < fields.length - 1;) {
            const status = fields[i++], first = fields[i++];
            if (status[0] === 'R' || status[0] === 'C')
                files.push({ status, path: fields[i++], originalPath: first });
            else
                files.push({ status, path: first });
        }
        const guard = this.files.validationScope(root);
        const visible = files.filter(file => {
            try {
                guard(file.path, { missing: true });
                if (file.originalPath)
                    guard(file.originalPath, { missing: true });
                return true;
            }
            catch {
                return false;
            }
        });
        return { hash, author: meta[1], date: meta[2], message: meta[3].trimEnd(), parents, base, files: visible, hiddenFiles: files.length - visible.length };
    }
    async commitFile(root: string, hash: string, p: string) {
        this.validPath(p);
        const commit = await this.commit(root, hash), file = commit.files.find(f => f.path === p);
        const deleted = file?.status === 'D', rev = deleted ? commit.base : commit.hash;
        const b = rev ? await this.blob(root, rev, p) : null;
        const decoded = this.decode(b);
        return { path: p, ...decoded, readOnly: true, commit: commit.hash, base: deleted ? `parent ${rev}` : `commit ${rev}`, deleted, encoding: 'utf-8', size: this.size(b) };
    }
    async diff(root: string, query: {
        path: string;
        side: 'staged' | 'unstaged' | 'commit';
        commit?: string;
    }) {
        const p = query.path;
        this.validPath(p);
        let before: GitBytes | null = null, after: GitBytes | null = null, base = '', originalPath: string | undefined;
        if (query.side === 'commit') {
            if (!query.commit)
                throw new GitError('커밋 해시가 필요합니다.');
            const c = await this.commit(root, query.commit), f = c.files.find(f => f.path === p);
            originalPath = f?.originalPath;
            before = c.base ? await this.blob(root, c.base, originalPath ?? p) : null;
            after = await this.blob(root, c.hash, p);
            base = c.base ? `first parent ${c.base} → ${c.hash}` : `empty tree → ${c.hash}`;
        }
        else {
            const status = await this.status(root), entry = status.entries.find(e => e.path === p);
            originalPath = entry?.originalPath;
            if (query.side === 'staged') {
                before = status.head ? await this.blob(root, status.head, originalPath ?? p) : null;
                after = await this.indexBlob(root, p);
                base = 'HEAD → index';
            }
            else if (query.side === 'unstaged') {
                before = await this.indexBlob(root, p);
                await this.safePath(root, p);
                try {
                    after = await this.worktreeBytes(root, p);
                }
                catch (e: any) {
                    if (e.code !== 'ENOENT')
                        throw e;
                }
                base = 'index → worktree';
            }
            else
                throw new GitError('잘못된 diff 기준입니다.');
        }
        if (this.size(before) + this.size(after) > 2 * 1024 * 1024)
            return { path: p, before: null, after: null, reason: 'diff 크기 제한(2 MiB)을 초과했습니다.', base, originalPath };
        const a = this.decode(before), b = this.decode(after);
        return { path: p, before: a.content, after: b.content, reason: a.reason ?? b.reason, base, originalPath };
    }
    async findExisting(root: string, body: OperationBody) {
        return this.store.existing(await this.canonical(root), body);
    }
    async close() {
        this.closing = true;
        await Promise.allSettled([...this.pending]);
    }
    async reconcile(root: string, id: string, confirmation: {
        confirmed: boolean;
    }) {
        root = await this.canonical(root);
        if (!confirmation?.confirmed)
            throw new GitError('실제 결과를 직접 확인한 뒤 명시적으로 확인하세요.');
        if (this.active.has(root))
            throw new GitError('Git 작업이 실행 중입니다.', 409);
        const op = await this.store.get(root, id);
        if (op.terminationUnconfirmed) {
            if (!op.processId)
                throw new GitError('프로세스 종료가 확인되지 않아 변경을 재개할 수 없습니다.', 409);
            try {
                process.kill(op.processId, 0);
                throw new GitError('기존 Git 프로세스가 아직 존재합니다. 종료 후 다시 확인하세요.', 409);
            }
            catch (e: any) {
                if (e.code !== 'ESRCH')
                    throw e;
            }
            op.terminationUnconfirmed = false;
        }
        if (op.state !== 'uncertain')
            throw new GitError('결과가 불확실한 작업만 확인할 수 있습니다.', 409);
        const status = await this.status(root);
        if (status.progress)
            throw new GitError('진행 중인 merge/rebase를 먼저 외부 Git에서 정리하세요.', 409);
        let remoteHead: string | null = null;
        if (op.kind === 'push' && op.remoteTarget && op.remoteRef) {
            if (!op.remoteRef.startsWith('refs/heads/'))
                throw new GitError('upstream 대상 확인이 필요합니다.', 409);
            remoteHead = (await this.text(root, ['ls-remote', '--exit-code', '--', op.remoteTarget, op.remoteRef])).split(/\s/)[0] || null;
        }
        op.reviewedAt = new Date().toISOString();
        op.summary = '사용자가 실제 Git 결과를 직접 확인했습니다. 원래 실행 결과는 불확실 상태로 보존합니다.';
        await this.store.save(op);
        return { operation: op, evidence: { head: status.head, remoteHead }, status };
    }
    async get(root: string, id: string) {
        return this.store.get(await this.canonical(root), id);
    }
    async start(root: string, body: OperationBody, hooks: {
        onSettled?: (op: GitOperation) => void | Promise<void>;
        assertAllowed?: () => void | Promise<void>;
    } = {}) {
        root = await this.canonical(root);
        if (this.closing)
            throw new GitError('Git 서비스 종료를 준비 중입니다.', 503);
        if (!body || typeof body.requestKey !== 'string' || !body.requestKey || body.requestKey.length > 200 || typeof body.token !== 'string')
            throw new GitError('요청 키와 상태 토큰이 필요합니다.');
        const existing = await this.store.existing(root, body);
        if (existing)
            return existing;
        if (this.active.has(root))
            throw new GitError('Git 작업이 실행 중입니다.', 409);
        this.active.add(root);
        let op: GitOperation;
        try {
            await hooks.assertAllowed?.();
            const status = await this.status(root);
            await this.validate(root, body, status);
            op = await this.store.create(root, body);
            op.startHead = status.head;
            op.commonDir = await this.commonDirectory(root);
            if (body.kind === 'push' && status.branch && status.remote) {
                op.remoteTarget = status.remote;
                op.pushDestinationCount = status.destinations?.length ?? 0;
                op.remoteRef = await this.text(root, ['config', '--get', 'branch.' + status.branch + '.merge']);
            }
            await this.store.save(op);
        }
        catch (e) {
            this.active.delete(root);
            throw e;
        }
        const task = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute(root, body, op)).finally(async () => {
            this.active.delete(root);
            await hooks.onSettled?.({ ...op });
        });
        this.pending.add(task);
        void task.finally(() => this.pending.delete(task)).catch(() => {
        });
        return { ...op };
    }
    private async validate(root: string, b: OperationBody, s: GitStatus) {
        if (!s.available)
            throw new GitError(s.reason ?? 'Git을 사용할 수 없습니다.', 503);
        if (s.blocked)
            throw new GitError(s.blocked, 409);
        if (b.token !== s.token)
            throw new GitError('Git 상태가 변경되었습니다. 새로고침 후 다시 확인하세요.', 409);
        if (!['stage', 'unstage', 'commit', 'create-branch', 'switch-branch', 'fetch', 'pull', 'push', 'continue-pull', 'abort-pull'].includes(b.kind))
            throw new GitError('지원하지 않는 Git 작업입니다.');
        const unresolved = (await this.store.all()).some(r => r.root === root && r.state === 'uncertain' && !r.reviewedAt);
        if (unresolved)
            throw new GitError('결과가 불확실한 이전 Git 작업을 먼저 확인해야 합니다.', 409);
        if (s.progress && !['stage', 'unstage', 'continue-pull', 'abort-pull'].includes(b.kind))
            throw new GitError('진행 중인 merge/rebase를 먼저 정리하세요.', 409);
        if (b.kind === 'stage' || b.kind === 'unstage') {
            if (!Array.isArray(b.paths) || !b.paths.length || b.paths.length > 200)
                throw new GitError('대상 파일(최대 200개)을 선택하세요.');
            for (const p of b.paths) {
                await this.safePath(root, p);
                if (!s.entries.some(e => e.path === p || e.originalPath === p))
                    throw new GitError('현재 변경 목록에 없는 파일입니다.', 409);
            }
        }
        if (b.kind === 'commit') {
            if (s.protectedIndex)
                throw new GitError('인덱스에 접근 제한 파일이 포함되어 있습니다. 외부 Git에서 정리하세요.', 409);
            if (typeof b.message !== 'string' || !b.message.trim() || b.message.length > 10000 || b.message.includes('\0'))
                throw new GitError('커밋 메시지를 입력하세요.');
            if (s.entries.some(e => e.conflicted))
                throw new GitError('미해결 충돌이 있습니다.', 409);
            if (!s.entries.some(e => e.index !== '.' && !e.untracked))
                throw new GitError('스테이징한 변경이 없습니다.', 409);
        }
        if (b.kind === 'create-branch' || b.kind === 'switch-branch') {
            if (!s.head)
                throw new GitError('먼저 초기 커밋을 생성하세요.', 409);
            if (typeof b.name !== 'string' || !b.name || b.name.startsWith('-'))
                throw new GitError('잘못된 브랜치 이름입니다.');
            await this.run(root, ['check-ref-format', '--branch', b.name]);
            const exists = (await this.branches(root)).branches.some(br => br.name === b.name);
            if ((b.kind === 'create-branch' && exists) || (b.kind === 'switch-branch' && !exists))
                throw new GitError('브랜치가 이미 존재하거나 찾을 수 없습니다.', 409);
        }
        if (['switch-branch', 'pull'].includes(b.kind) && (s.entries.length || s.hiddenChanges))
            throw new GitError('변경 파일을 저장·커밋하여 작업 트리를 정리하세요.', 409);
        if (b.kind === 'fetch' && (!b.remote || b.remote.startsWith('-') || !s.remotes.includes(b.remote)))
            throw new GitError('등록된 원격을 선택하세요.');
        if (['pull', 'push'].includes(b.kind) && (!s.branch || !s.upstream || !s.remote))
            throw new GitError('브랜치와 기존 upstream 설정이 필요합니다.', 409);
        if (b.kind === 'push' && !b.confirmed)
            throw new GitError('전송할 커밋과 대상을 확인하세요.');
        if (['continue-pull', 'abort-pull'].includes(b.kind)) {
            if (!s.progress?.owned)
                throw new GitError('앱이 시작한 pull 진행 상태가 아닙니다.', 409);
            if (b.kind === 'abort-pull' && !b.confirmed)
                throw new GitError('충돌 해결 변경이 사라질 수 있음을 확인하세요.');
            if (b.kind === 'continue-pull' && (s.entries.some(e => e.conflicted || (!e.untracked && e.worktree !== '.')) || s.entries.some(e => e.untracked)))
                throw new GitError('충돌 해결을 저장하고 모두 스테이징하세요.', 409);
        }
    }
    private async execute(root: string, b: OperationBody, op: GitOperation) {
        try {
            const s = await this.status(root);
            if (s.token !== b.token)
                throw new GitError('실행 전에 Git 상태가 변경되었습니다.', 409);
            const selected = [...new Set((b.paths ?? []).flatMap(p => {
                    const entry = s.entries.find(e => e.path === p);
                    return entry?.originalPath ? [p, entry.originalPath] : [p];
                }))];
            let args: string[] = [];
            switch (b.kind) {
                case 'stage':
                    args = ['add', '-A', '--', ...selected];
                    break;
                case 'unstage':
                    args = s.head ? ['reset', '-q', 'HEAD', '--', ...selected] : ['rm', '--cached', '-f', '-q', '--', ...selected];
                    break;
                case 'commit':
                    args = ['commit', '-m', b.message!];
                    break;
                case 'create-branch':
                    args = ['branch', '--', b.name!];
                    break;
                case 'switch-branch':
                    args = ['switch', b.name!];
                    break;
                case 'fetch':
                    args = ['fetch', '--', b.remote!];
                    break;
                case 'pull':
                    args = ['pull'];
                    break;
                case 'push': {
                    const merge = await this.text(root, ['config', '--get', `branch.${s.branch}.merge`]);
                    if (!merge.startsWith('refs/heads/'))
                        throw new GitError('upstream 대상 브랜치를 확인할 수 없습니다.');
                    args = ['push', '--porcelain', '--', s.remote!, `HEAD:${merge}`];
                    break;
                }
                case 'continue-pull':
                    args = [s.progress!.kind, '--continue'];
                    break;
                case 'abort-pull':
                    args = [s.progress!.kind, '--abort'];
                    break;
            }
            await runGit(root, args, { ...this.options, onSpawn: async (pid) => {
                    op.processId = pid;
                    await this.store.save(op);
                } });
            op.state = op.status = 'succeeded';
            if (b.kind === 'commit') {
                op.result = { hash: await this.text(root, ['rev-parse', 'HEAD']) };
                op.head = op.result.hash;
            }
        }
        catch (e) {
            const pushUncertain = b.kind === 'push' && !!op.processId && (!(e instanceof GitError) || !e.confirmedRejection || op.pushDestinationCount !== 1);
            op.state = op.status = (e instanceof GitError && e.uncertain) || pushUncertain ? 'uncertain' : 'failed';
            op.summary = op.error = scrub((e as Error).message);
            if (e instanceof GitError)
                op.terminationUnconfirmed = e.terminationUnconfirmed;
        }
        finally {
            try {
                const progress = await this.progressData(root);
                if (progress && ['pull', 'continue-pull', 'abort-pull'].includes(b.kind)) {
                    const status = await this.status(root);
                    op.progressKind = progress.kind;
                    op.progressFingerprint = progress.fingerprint;
                    if (op.state !== 'uncertain')
                        op.state = op.status = status.entries.some(e => e.conflicted) ? 'conflicted' : 'awaiting-continue';
                }
                await this.store.save(op);
            }
            catch (e) {
                op.state = op.status = 'uncertain';
                op.summary = '작업 결과 기록을 확인할 수 없습니다. 실제 Git 상태를 확인하세요.';
                try {
                    await this.store.save(op);
                }
                catch {
                }
            }
        }
    }
}
