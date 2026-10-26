import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { GitError } from './git-runner';
export const operationKinds = ['stage', 'unstage', 'commit', 'create-branch', 'switch-branch', 'fetch', 'pull', 'push'] as const;
export type OperationKind = typeof operationKinds[number];
/** Old records remain readable; these kinds cannot be submitted as new mutations. */
export type RecordedOperationKind = OperationKind | 'continue-pull' | 'abort-pull';
export function assertOperationKind(value: unknown): asserts value is OperationKind {
    if (!(operationKinds as readonly unknown[]).includes(value)) throw new GitError('지원하지 않는 Git 작업입니다.');
}
export interface OperationBody {
    kind: OperationKind;
    paths?: string[];
    message?: string;
    name?: string;
    remote?: string;
    token: string;
    requestKey: string;
    confirmed?: boolean;
}
export interface GitOperation {
    id: string;
    operationId: string;
    root: string;
    kind: RecordedOperationKind;
    state: string;
    status: string;
    requestKey: string;
    createdAt: string;
    updatedAt: string;
    token: string;
    fingerprint: string;
    summary?: string;
    error?: string;
    head?: string;
    result?: {
        hash?: string;
    };
    startHead?: string | null;
    progressKind?: 'merge' | 'rebase';
    progressFingerprint?: string;
    reviewedAt?: string;
    processId?: number;
    commonDir?: string;
    pushDestinationCount?: number;
    remoteTarget?: string;
    remoteRef?: string;
    terminationUnconfirmed?: boolean;
}
export const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export class OperationStore {
    private records = new Map<string, GitOperation>();
    private ready: Promise<void>;
    constructor(private dir: string) {
        this.ready = this.load();
    }
    private async load() {
        await mkdir(this.dir, { recursive: true });
        for (const file of await readdir(this.dir)) {
            if (!/^[a-f0-9-]+\.json$/.test(file))
                continue;
            try {
                const r = JSON.parse(await readFile(path.join(this.dir, file), 'utf8')) as GitOperation;
                if (r.state === 'running') {
                    r.state = r.status = 'uncertain';
                    r.terminationUnconfirmed = true;
                    r.summary = '서버가 다시 시작되었습니다. 실제 Git 상태를 확인하세요.';
                    await this.save(r);
                }
                this.records.set(r.id, r);
            }
            catch {
            }
        }
    }
    async all() {
        await this.ready;
        return [...this.records.values()];
    }
    async get(root: string, id: string) {
        await this.ready;
        const r = this.records.get(id) ?? [...this.records.values()].find(record => record.root === root && record.requestKey === id);
        if (!r || r.root !== root)
            throw new GitError('Git 작업을 찾을 수 없습니다.', 404);
        return { ...r };
    }
    async existing(root: string, b: OperationBody) {
        await this.ready;
        const fingerprint = digest(JSON.stringify(b));
        const found = [...this.records.values()].find(r => r.root === root && r.requestKey === b.requestKey);
        if (found && found.fingerprint !== fingerprint)
            throw new GitError('같은 요청 키에 다른 작업을 사용할 수 없습니다.', 409);
        return found ? { ...found } : undefined;
    }
    async create(root: string, b: OperationBody) {
        await this.ready;
        const now = new Date().toISOString(), id = randomUUID();
        const record: GitOperation = { id, operationId: id, root, kind: b.kind, state: 'running', status: 'running', requestKey: b.requestKey, token: b.token, fingerprint: digest(JSON.stringify(b)), createdAt: now, updatedAt: now };
        await this.save(record);
        return record;
    }
    async save(r: GitOperation) {
        r.updatedAt = new Date().toISOString();
        const target = path.join(this.dir, r.id + '.json'), tmp = target + '.tmp';
        await writeFile(tmp, JSON.stringify(r), 'utf8');
        await rename(tmp, target);
        this.records.set(r.id, { ...r });
    }
}
