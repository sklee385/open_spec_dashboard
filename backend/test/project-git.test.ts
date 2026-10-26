import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { ProjectGit } from '../src/projects/git';
vi.setConfig({ testTimeout: 60000 });
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function repo() {
    const root = await mkdtemp(path.join(tmpdir(), 'project-git-'));
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Tester');
    git(root, 'config', 'user.email', 'test@example.test');
    return root;
}
async function settled(service: ProjectGit, root: string, body: any) {
    const op = await service.start(root, body);
    for (let n = 0; n < 2000; n++) {
        const current = await service.get(root, op.id);
        if (current.state !== 'running')
            return current;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('operation did not settle');
}
async function mutate(s: ProjectGit, r: string, kind: string, rest: any = {}) {
    return settled(s, r, { kind, token: (await s.status(r)).token, requestKey: crypto.randomUUID(), ...rest });
}
describe('project Git service', () => {
    it('handles unborn, literal filenames, partial staging, stale previews and immutable history', async () => {
        const root = await repo(), s = new ProjectGit({ dataDir: await mkdtemp(path.join(tmpdir(), 'git-records-')) });
        await writeFile(path.join(root, '[literal] 한글.txt'), 'one\n');
        let status = await s.status(root);
        expect(status.head).toBeNull();
        expect(status.entries.some(e => e.path === '[literal] 한글.txt')).toBe(true);
        expect((await mutate(s, root, 'stage', { paths: ['[literal] 한글.txt'] })).state).toBe('succeeded');
        await writeFile(path.join(root, '[literal] 한글.txt'), 'two\n');
        expect((await s.diff(root, { path: '[literal] 한글.txt', side: 'staged' })).after).toBe('one\n');
        expect((await s.diff(root, { path: '[literal] 한글.txt', side: 'unstaged' })).after).toBe('two\n');
        const stale = (await s.status(root)).token;
        await writeFile(path.join(root, '[literal] 한글.txt'), 'three\n');
        await expect(s.start(root, { kind: 'commit', token: stale, requestKey: 'stale', message: 'first' })).rejects.toThrow();
        const op = await mutate(s, root, 'commit', { message: 'first' });
        expect(op.state).toBe('succeeded');
        expect((await s.commitFile(root, op.result!.hash!, '[literal] 한글.txt')).content).toBe('one\n');
        expect((await s.commit(root, op.result!.hash!)).base).toBeNull();
        expect((await s.log(root)).commits).toHaveLength(1);
    });
    it('deduplicates persisted requests, rejects payload collisions and recovers unfinished records', async () => {
        const root = await repo(), dir = await mkdtemp(path.join(tmpdir(), 'git-records-')), s = new ProjectGit({ dataDir: dir });
        await writeFile(path.join(root, 'a'), 'a');
        const body = { kind: 'stage' as const, paths: ['a'], token: (await s.status(root)).token, requestKey: 'same' };
        const op = await settled(s, root, body);
        expect((await s.start(root, body)).id).toBe(op.id);
        await expect(s.start(root, { ...body, paths: ['b'] })).rejects.toThrow();
        expect((await new ProjectGit({ dataDir: dir }).get(root, op.id)).state).toBe('succeeded');
    });
    it('rejects ancestor repository mutations and dirty switching, preserves hooks', async () => {
        const root = await repo(), s = new ProjectGit({ dataDir: await mkdtemp(path.join(tmpdir(), 'git-records-')) });
        await mkdir(path.join(root, 'child'));
        await writeFile(path.join(root, 'a'), 'a');
        await mutate(s, root, 'stage', { paths: ['a'] });
        await mutate(s, root, 'commit', { message: 'first' });
        expect((await s.status(path.join(root, 'child'))).blocked).toBeTruthy();
        await expect(mutate(s, path.join(root, 'child'), 'create-branch', { name: 'bad' })).rejects.toThrow();
        await mutate(s, root, 'create-branch', { name: 'feature' });
        await writeFile(path.join(root, 'a'), 'dirty');
        await expect(mutate(s, root, 'switch-branch', { name: 'feature' })).rejects.toThrow();
        await writeFile(path.join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n');
        await mutate(s, root, 'stage', { paths: ['a'] });
        expect((await mutate(s, root, 'commit', { message: 'blocked' })).state).toBe('failed');
    });
});
async function remotePair() {
    const remote = await mkdtemp(path.join(tmpdir(), 'git-bare-'));
    git(remote, 'init', '--bare', '--initial-branch=main');
    const root = await repo();
    await writeFile(path.join(root, 'file.txt'), 'base\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-u', 'origin', 'main');
    const peer = await mkdtemp(path.join(tmpdir(), 'git-peer-'));
    git(peer, 'clone', remote, '.');
    git(peer, 'config', 'user.name', 'Peer');
    git(peer, 'config', 'user.email', 'peer@example.test');
    return { root, remote, peer, s: new ProjectGit({ dataDir: await mkdtemp(path.join(tmpdir(), 'git-records-')) }) };
}
describe('project Git remote operations', () => {
    it('fetches only known remotes, pushes just the explicit upstream and preserves existing pull policy', async () => {
        const { root, remote, peer, s } = await remotePair();
        await expect(mutate(s, root, 'fetch', { remote: 'https://example.test' })).rejects.toThrow();
        await writeFile(path.join(root, 'local.txt'), 'local');
        await mutate(s, root, 'stage', { paths: ['local.txt'] });
        const committed = await mutate(s, root, 'commit', { message: 'local' });
        expect(committed.status).toBe('succeeded');
        git(root, 'config', 'push.default', 'matching');
        git(root, 'branch', 'other');
        await expect(mutate(s, root, 'push')).rejects.toThrow();
        expect((await mutate(s, root, 'push', { confirmed: true })).status).toBe('succeeded');
        expect(git(remote, 'branch', '--list', 'other')).toBe('');
        git(peer, 'pull', '--ff-only');
        await writeFile(path.join(peer, 'remote.txt'), 'remote');
        git(peer, 'add', '.');
        git(peer, 'commit', '-m', 'remote');
        git(peer, 'push');
        expect((await mutate(s, root, 'fetch', { remote: 'origin' })).status).toBe('succeeded');
        expect((await s.status(root)).behind).toBe(1);
        git(root, 'config', 'pull.ff', 'only');
        expect((await mutate(s, root, 'pull')).status).toBe('succeeded');
        expect(git(root, 'config', 'pull.ff')).toBe('only');
        expect(await readFile(path.join(root, 'remote.txt'), 'utf8')).toBe('remote');
    });
    it('owns merge pull conflicts, requires resolved index and supports continue with default message', async () => {
        const { root, peer, s } = await remotePair();
        git(root, 'config', 'pull.rebase', 'false');
        await writeFile(path.join(root, 'file.txt'), 'local\n');
        git(root, 'commit', '-am', 'local');
        await writeFile(path.join(peer, 'file.txt'), 'peer\n');
        git(peer, 'commit', '-am', 'peer');
        git(peer, 'push');
        const pull = await mutate(s, root, 'pull');
        expect(pull.status).toBe('conflicted');
        expect((await s.status(root)).progress?.owned).toBe(true);
        await expect(mutate(s, root, 'continue-pull')).rejects.toThrow();
        await writeFile(path.join(root, 'file.txt'), 'resolved\n');
        await mutate(s, root, 'stage', { paths: ['file.txt'] });
        expect((await mutate(s, root, 'continue-pull')).status).toBe('succeeded');
        expect((await s.status(root)).progress).toBeNull();
        expect((await s.commit(root, git(root, 'rev-parse', 'HEAD'))).parents).toHaveLength(2);
    });
    it('recovers owned rebase across service restart and aborts only with confirmation', async () => {
        const { root, peer, s } = await remotePair();
        git(root, 'config', 'pull.rebase', 'true');
        await writeFile(path.join(root, 'file.txt'), 'local\n');
        git(root, 'commit', '-am', 'local');
        const start = git(root, 'rev-parse', 'HEAD');
        await writeFile(path.join(peer, 'file.txt'), 'peer\n');
        git(peer, 'commit', '-am', 'peer');
        git(peer, 'push');
        expect((await mutate(s, root, 'pull')).status).toBe('conflicted');
        await expect(mutate(s, root, 'abort-pull')).rejects.toThrow();
        expect((await mutate(s, root, 'abort-pull', { confirmed: true })).status).toBe('succeeded');
        expect(git(root, 'rev-parse', 'HEAD')).toBe(start);
        expect((await s.status(root)).progress).toBeNull();
    });
    it('shows external merge without adopting it and returns deleted parent content', async () => {
        const root = await repo(), s = new ProjectGit({ dataDir: await mkdtemp(path.join(tmpdir(), 'git-records-')) });
        await writeFile(path.join(root, 'file'), 'before');
        git(root, 'add', '.');
        git(root, 'commit', '-m', 'base');
        git(root, 'rm', 'file');
        git(root, 'commit', '-m', 'delete');
        const hash = git(root, 'rev-parse', 'HEAD');
        const f = await s.commitFile(root, hash, 'file');
        expect(f.content).toBe('before');
        expect(f.deleted).toBe(true);
        expect((await s.diff(root, { path: 'file', side: 'commit', commit: hash })).after).toBeNull();
    });
});
describe('project Git safety limits', () => {
    it('blocks excluded runtime paths and entire-index commits containing protected data', async () => {
        const root = await repo(), s = new ProjectGit({ dataDir: await mkdtemp(path.join(tmpdir(), 'git-records-')) });
        await mkdir(path.join(root, '.data'));
        await writeFile(path.join(root, '.data', 'secret'), 'private');
        git(root, 'add', '.data/secret');
        await expect(s.diff(root, { path: '.data/secret', side: 'staged' })).rejects.toThrow();
        await expect(mutate(s, root, 'commit', { message: 'never' })).rejects.toThrow();
        expect((await s.status(root)).entries.some(e => e.path === '.data/secret')).toBe(false);
        git(root, 'commit', '-m', 'external protected');
        expect((await s.commit(root, git(root, 'rev-parse', 'HEAD'))).files.some(f => f.path === '.data/secret')).toBe(false);
    });
    it('unstages both sides of a rename and supports initial-index removal', async () => {
        const root = await repo(), s = new ProjectGit({ dataDir: await mkdtemp(path.join(tmpdir(), 'git-records-')) });
        await writeFile(path.join(root, 'old'), 'a');
        await mutate(s, root, 'stage', { paths: ['old'] });
        expect((await mutate(s, root, 'unstage', { paths: ['old'] })).state).toBe('succeeded');
        git(root, 'add', '.');
        git(root, 'commit', '-m', 'base');
        git(root, 'mv', 'old', 'new');
        expect((await mutate(s, root, 'unstage', { paths: ['new'] })).state).toBe('succeeded');
        expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
    });
});
import { runGit, GitError } from '../src/projects/git-runner';
describe('bounded Git runner and failure states', () => {
    it('bounds execution and removes URL credentials from failures', async () => {
        const root = await repo();
        await expect(runGit(root, ['-c', 'alias.slow=!sleep 10', 'slow'], { timeoutMs: 200 })).rejects.toMatchObject({ uncertain: true });
        await expect(runGit(root, ['-c', 'alias.failure=!echo https://user:secret@example.test/repo >&2; exit 1', 'failure'])).rejects.not.toThrow('secret');
    });
    it('marks persisted interrupted work uncertain and prevents automatic resubmission', async () => {
        const root = await repo(), dir = await mkdtemp(path.join(tmpdir(), 'git-records-'));
        await mkdir(path.join(dir, 'project-git-operations'));
        const id = crypto.randomUUID(), now = new Date().toISOString();
        await writeFile(path.join(dir, 'project-git-operations', id + '.json'), JSON.stringify({ id, operationId: id, root, kind: 'push', state: 'running', status: 'running', createdAt: now, updatedAt: now, requestKey: 'interrupted', token: 'old' }));
        const s = new ProjectGit({ dataDir: dir });
        expect((await s.get(root, id)).state).toBe('uncertain');
        await writeFile(path.join(root, 'a'), 'a');
        await expect(mutate(s, root, 'stage', { paths: ['a'] })).rejects.toThrow();
    });
    it('reports signing failures without bypassing configured signing', async () => {
        const root = await repo(), s = new ProjectGit({ dataDir: await mkdtemp(path.join(tmpdir(), 'git-records-')) });
        await writeFile(path.join(root, 'a'), 'a');
        await mutate(s, root, 'stage', { paths: ['a'] });
        git(root, 'config', 'commit.gpgSign', 'true');
        git(root, 'config', 'gpg.program', 'does-not-exist-signing-program');
        const op = await mutate(s, root, 'commit', { message: 'must sign' });
        expect(op.state).toBe('failed');
        expect((await s.status(root)).head).toBeNull();
    });
});
describe('pull recovery and historical boundaries', () => {
    it('resumes multiple rebase conflicts and restores ownership after service restart', async () => {
        const { root, peer, s } = await remotePair();
        git(root, 'config', 'pull.rebase', 'true');
        await writeFile(path.join(root, 'file.txt'), 'local one\n');
        git(root, 'commit', '-am', 'one');
        await writeFile(path.join(root, 'file.txt'), 'local two\n');
        git(root, 'commit', '-am', 'two');
        await writeFile(path.join(peer, 'file.txt'), 'peer\n');
        git(peer, 'commit', '-am', 'peer');
        git(peer, 'push');
        expect((await mutate(s, root, 'pull')).status).toBe('conflicted');
        const restored = new ProjectGit({ dataDir: (s as any).options.dataDir });
        expect((await restored.status(root)).progress?.owned).toBe(true);
        await writeFile(path.join(root, 'file.txt'), 'resolved one\n');
        await mutate(restored, root, 'stage', { paths: ['file.txt'] });
        expect((await mutate(restored, root, 'continue-pull')).status).toBe('conflicted');
        await writeFile(path.join(root, 'file.txt'), 'resolved two\n');
        await mutate(restored, root, 'stage', { paths: ['file.txt'] });
        expect((await mutate(restored, root, 'continue-pull')).status).toBe('succeeded');
        expect((await restored.status(root)).progress).toBeNull();
        expect(git(root, 'log', '--format=%s', '-2')).toBe('two\none');
    });
    it('resolves modify/delete pull conflict through deletion and stage', async () => {
        const { root, peer, s } = await remotePair();
        git(root, 'config', 'pull.rebase', 'false');
        await writeFile(path.join(root, 'file.txt'), 'local\n');
        git(root, 'commit', '-am', 'local');
        git(peer, 'rm', 'file.txt');
        git(peer, 'commit', '-m', 'delete');
        git(peer, 'push');
        expect((await mutate(s, root, 'pull')).status).toBe('conflicted');
        const fs = await import('node:fs/promises');
        await fs.unlink(path.join(root, 'file.txt'));
        await mutate(s, root, 'stage', { paths: ['file.txt'] });
        expect((await mutate(s, root, 'continue-pull')).status).toBe('succeeded');
        expect((await s.status(root)).entries).toHaveLength(0);
    });
    it('preserves binary metadata, detached HEAD and linked worktree boundaries', async () => {
        const root = await repo(), s = new ProjectGit({ dataDir: await mkdtemp(path.join(tmpdir(), 'git-records-')) });
        await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
        git(root, 'add', '.');
        git(root, 'commit', '-m', 'binary');
        expect((await s.commitFile(root, git(root, 'rev-parse', 'HEAD'), 'binary')).reason).toContain('바이너리');
        git(root, 'checkout', '--detach');
        expect((await s.status(root)).branch).toBeNull();
        expect((await mutate(s, root, 'create-branch', { name: 'from-detached' })).status).toBe('succeeded');
        await expect(mutate(s, root, 'push', { confirmed: true })).rejects.toThrow();
        const worktree = path.join(await mkdtemp(path.join(tmpdir(), 'git-worktree-parent-')), 'linked');
        git(root, 'worktree', 'add', worktree, 'from-detached');
        expect((await s.status(worktree)).available).toBe(true);
        expect((await s.status(worktree)).blocked).toBeUndefined();
    });
});
describe('large Git object summaries', () => {
    it('returns metadata for oversized worktree and historical blobs without output overflow', async () => {
        const root = await repo(), s = new ProjectGit({ dataDir: await mkdtemp(path.join(tmpdir(), 'git-records-')) });
        await writeFile(path.join(root, 'large'), Buffer.alloc(10 * 1024 * 1024, 97));
        git(root, 'add', '.');
        git(root, 'commit', '-m', 'large');
        const hash = git(root, 'rev-parse', 'HEAD');
        expect((await s.commitFile(root, hash, 'large')).reason).toContain('크기');
        await writeFile(path.join(root, 'large'), Buffer.alloc(2 * 1024 * 1024, 98));
        expect((await s.diff(root, { path: 'large', side: 'unstaged' })).reason).toContain('크기');
    });
});
describe('uncertain operation review', () => {
    it('looks up lost responses by scoped request key and releases only explicitly reviewed uncertainty', async () => {
        const root = await repo(), dir = await mkdtemp(path.join(tmpdir(), 'git-records-')), id = crypto.randomUUID(), now = new Date().toISOString();
        await mkdir(path.join(dir, 'project-git-operations'));
        await writeFile(path.join(dir, 'project-git-operations', id + '.json'), JSON.stringify({ id, operationId: id, root, kind: 'stage', state: 'uncertain', status: 'uncertain', createdAt: now, updatedAt: now, requestKey: 'lost-response', token: 'old', terminationUnconfirmed: true, processId: 99999999 }));
        const s = new ProjectGit({ dataDir: dir });
        expect((await s.get(root, 'lost-response')).id).toBe(id);
        await expect(s.assertReady(root)).rejects.toThrow();
        await expect(s.reconcile(root, id, { confirmed: false })).rejects.toThrow();
        expect((await s.reconcile(root, id, { confirmed: true })).operation.status).toBe('uncertain');
        await expect(s.assertReady(root)).resolves.toBeUndefined();
        const other = await repo();
        await expect(s.get(other, 'lost-response')).rejects.toThrow();
        await s.close();
    });
});
describe('remote rejection and external progress', () => {
    it('keeps a non-fast-forward push rejected and does not overwrite remote history', async () => {
        const { root, peer, remote, s } = await remotePair();
        await writeFile(path.join(root, 'local'), 'local');
        git(root, 'add', '.');
        git(root, 'commit', '-m', 'local');
        await writeFile(path.join(peer, 'peer'), 'peer');
        git(peer, 'add', '.');
        git(peer, 'commit', '-m', 'peer');
        git(peer, 'push');
        const before = git(remote, 'rev-parse', 'main');
        expect((await mutate(s, root, 'push', { confirmed: true })).status).toBe('failed');
        expect(git(remote, 'rev-parse', 'main')).toBe(before);
    });
    it('does not adopt an externally started merge and preserves configured pull.ff rejection', async () => {
        const { root, peer, s } = await remotePair();
        git(root, 'config', 'pull.ff', 'only');
        await writeFile(path.join(root, 'file.txt'), 'local');
        git(root, 'commit', '-am', 'local');
        await writeFile(path.join(peer, 'file.txt'), 'peer');
        git(peer, 'commit', '-am', 'peer');
        git(peer, 'push');
        expect((await mutate(s, root, 'pull')).status).toBe('failed');
        expect(git(root, 'config', 'pull.ff')).toBe('only');
        git(root, 'fetch', 'origin');
        try {
            git(root, 'merge', 'origin/main');
        }
        catch {
        }
        expect((await s.status(root)).progress?.owned).toBe(false);
        await expect(mutate(s, root, 'abort-pull', { confirmed: true })).rejects.toThrow();
        await expect(mutate(s, root, 'continue-pull')).rejects.toThrow();
    });
    it('persists timed out mutations and does not retry the same request', async () => {
        const root = await repo(), dir = await mkdtemp(path.join(tmpdir(), 'git-records-')), s = new ProjectGit({ dataDir: dir, timeoutMs: 2000 });
        await writeFile(path.join(root, 'a'), 'a');
        git(root, 'add', '.');
        await writeFile(path.join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nsleep 10\n');
        const body = { kind: 'commit' as const, message: 'timeout message stays private', token: (await s.status(root)).token, requestKey: 'timeout-once' };
        const result = await settled(s, root, body);
        expect(result.status).toBe('uncertain');
        expect((await s.start(root, body)).id).toBe(result.id);
        await expect(s.assertReady(root)).rejects.toThrow();
        const contents = await readFile(path.join(dir, 'project-git-operations', result.id + '.json'), 'utf8');
        expect(contents).not.toContain('timeout message stays private');
        await s.close();
    });
});
describe('history pagination', () => {
    it('anchors later pages to the original HEAD when new commits arrive', async () => {
        const root = await repo(), s = new ProjectGit({ dataDir: await mkdtemp(path.join(tmpdir(), 'git-records-')) });
        let stream = '';
        for (let i = 1; i <= 51; i++) {
            const message = 'history ' + i;
            stream += 'commit refs/heads/main\nmark :' + i + '\nauthor Tester <test@example.test> ' + (1700000000 + i) + ' +0000\ncommitter Tester <test@example.test> ' + (1700000000 + i) + ' +0000\ndata ' + Buffer.byteLength(message) + '\n' + message + '\n' + (i > 1 ? 'from :' + (i - 1) + '\n' : '') + '\n';
        }
        execFileSync('git', ['fast-import', '--quiet'], { cwd: root, input: stream });
        const first = await s.log(root);
        expect(first.commits).toHaveLength(50);
        expect(first.nextCursor).toBeTruthy();
        git(root, 'commit', '--allow-empty', '-m', 'new top');
        const second = await s.log(root, first.nextCursor!);
        expect(second.commits.map(c => c.message)).toEqual(['history 1']);
    });
});
describe('Git availability and runner output limits', () => {
    it('distinguishes a non-repository from a missing Git executable', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'not-a-repo-')), s = new ProjectGit({ dataDir: await mkdtemp(path.join(tmpdir(), 'git-records-')) });
        expect((await s.status(root)).available).toBe(false);
        const original = process.env.PATH;
        try {
            process.env.PATH = '';
            const status = await s.status(root);
            expect(status.available).toBe(false);
            expect(status.reason).toContain('설치');
        }
        finally {
            process.env.PATH = original;
        }
    });
    it('rejects bounded command output overflow', async () => {
        const root = await repo();
        await expect(runGit(root, ['-c', 'alias.output=!printf 123456789', 'output'], { maxOutputBytes: 4 })).rejects.toThrow('출력 제한');
    });
});
describe('complete push preview', () => {
    it('does not silently truncate outgoing commit identities', async () => {
        const { root, s } = await remotePair();
        let previous = git(root, 'rev-parse', 'HEAD'), stream = '';
        for (let i = 1; i <= 201; i++) {
            const message = 'outgoing ' + i;
            stream += 'commit refs/heads/main\nmark :' + i + '\nauthor Tester <test@example.test> ' + (1700000000 + i) + ' +0000\ncommitter Tester <test@example.test> ' + (1700000000 + i) + ' +0000\ndata ' + Buffer.byteLength(message) + '\n' + message + '\nfrom ' + previous + '\n\n';
            previous = ':' + i;
        }
        execFileSync('git', ['fast-import', '--quiet'], { cwd: root, input: stream });
        expect((await s.status(root)).outgoing).toHaveLength(201);
    });
});
describe('index removal and remote preview freshness', () => {
    it('unstages an unborn partial index without changing working contents', async () => {
        const root = await repo(), s = new ProjectGit({ dataDir: await mkdtemp(path.join(tmpdir(), 'git-records-')) });
        await writeFile(path.join(root, 'a'), 'staged');
        git(root, 'add', 'a');
        await writeFile(path.join(root, 'a'), 'working');
        expect((await mutate(s, root, 'unstage', { paths: ['a'] })).status).toBe('succeeded');
        expect(await readFile(path.join(root, 'a'), 'utf8')).toBe('working');
        expect(git(root, 'ls-files')).toBe('');
    });
    it('invalidates a push confirmation after the existing remote URL is remapped', async () => {
        const { root, s } = await remotePair();
        const token = (await s.status(root)).token;
        git(root, 'remote', 'set-url', 'origin', path.join(root, 'different-target'));
        expect((await s.status(root)).token).not.toBe(token);
        await expect(s.start(root, { kind: 'push', token, requestKey: 'stale-target', confirmed: true })).rejects.toThrow();
    });
});
describe('safe remote confirmation metadata', () => {
    it('labels every configured push destination without embedded credentials or query strings', async () => {
        const { root, s } = await remotePair();
        git(root, 'remote', 'set-url', 'origin', 'https://user:secret@example.test/team/repo.git?token=credential-query-secret');
        git(root, 'remote', 'set-url', '--add', '--push', 'origin', 'ssh://private@example.test/team/other.git');
        const status = await s.status(root);
        expect((status as any).destinations).toEqual(['ssh://example.test/other.git']);
        expect(JSON.stringify(status)).not.toContain('secret');
        expect(JSON.stringify(status)).not.toContain('credential-query-secret');
    });
});
describe('push response loss', () => {
    it('preserves uncertainty when receive-pack updates the remote but its wrapper then fails', async () => {
        const { root, remote, s } = await remotePair();
        const wrapper = path.join(await mkdtemp(path.join(tmpdir(), 'git-wrapper-')), 'receive.sh');
        await writeFile(wrapper, '#!/bin/sh\ngit-receive-pack "$@"\nexit 1\n');
        git(root, 'config', 'remote.origin.receivepack', 'sh "' + wrapper.replace(/\\/g, '/') + '"');
        await writeFile(path.join(root, 'new'), 'new');
        git(root, 'add', '.');
        git(root, 'commit', '-m', 'sent');
        const head = git(root, 'rev-parse', 'HEAD');
        const operation = await mutate(s, root, 'push', { confirmed: true });
        expect(git(remote, 'rev-parse', 'main')).toBe(head);
        expect(operation.status).toBe('uncertain');
        await expect(s.assertReady(root)).rejects.toThrow();
    });
});
