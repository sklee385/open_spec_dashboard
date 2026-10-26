import { ConflictException } from '@nestjs/common';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Work, WorkStore } from '../work/store';
import { gitCommonDirectory } from './git-metadata';

const coordinators = new WeakMap<WorkStore, ProjectOperationCoordinator>();
const activeStates = new Set(['connecting', 'creating-thread', 'running', 'waiting-input', 'waiting-approval', 'recovery-required']);

function canonical(path: string) {
  let value: string;
  try { value = realpathSync(path); } catch { value = resolve(path); }
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Per-store coordination is shared by HTTP, queued AI turns and verification. */
export function projectCoordinator(store: WorkStore) {
  let coordinator = coordinators.get(store);
  if (!coordinator) { coordinator = new ProjectOperationCoordinator(store); coordinators.set(store, coordinator); }
  return coordinator;
}

export class ProjectOperationCoordinator {
  private readonly locks = new Map<string, symbol>();
  private readonly blocked = new Set<string>();
  private readonly recordsDirectory = join(resolve(process.env.DATA_DIR || '../.data'), 'project-git-operations');
  constructor(private readonly store: WorkStore) {}

  private keys(root: string): string[] {
    const path = canonical(root);
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete (env as NodeJS.ProcessEnv)[name];
    const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, shell: false, windowsHide: true, timeout: 2000, encoding: 'utf8', maxBuffer: 8192, env });
    const common = git.status === 0 ? git.stdout.trim() : gitCommonDirectory(root) || '';
    return common && isAbsolute(common) ? [path, `git:${canonical(common)}`] : [path];
  }

  private workKeys(work: Work) {
    return [...new Set([work.projectPath, ...(work.executionPath ? [work.executionPath] : [])].flatMap(root => this.keys(root)))];
  }

  private assertKeysFree(keys: string[]) {
    if (keys.some(key => this.locks.has(key) || this.blocked.has(key))) throw new ConflictException('프로젝트의 파일·Git 작업이 진행 중이거나 복구 확인이 필요합니다');
    let names: string[];
    try { names = readdirSync(this.recordsDirectory).filter(name => name.endsWith('.json')); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw new ConflictException('Git 작업 기록을 확인할 수 없습니다'); }
    if (names.length > 10000) throw new ConflictException('Git 작업 기록 정리가 필요합니다');
    for (const name of names) {
      let record: { root: string; commonDir?: string; state?: string; status?: string; reviewedAt?: string };
      try {
        const path = join(this.recordsDirectory, name);
        if (statSync(path).size > 65536) throw new Error();
        record = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof record.root !== 'string') throw new Error();
      } catch { throw new ConflictException('Git 작업 기록이 손상되어 복구 확인이 필요합니다'); }
      if (record.reviewedAt || !['running', 'uncertain'].includes(record.state || record.status || '')) continue;
      const recordKeys = [canonical(record.root), ...(record.commonDir ? [`git:${canonical(record.commonDir)}`] : [])];
      if (recordKeys.some(key => keys.includes(key))) throw new ConflictException('미확인 Git 작업을 실제 상태 확인으로 정리한 뒤 새 실행을 시작해 주세요');
    }
  }

  assertWorkCanStart(work: Work) { this.assertKeysFree(this.workKeys(work)); }

  acquire(root: string) {
    const keys = this.keys(root);
    this.assertKeysFree(keys);
    for (const work of this.store.list()) {
      if (['completed', 'archived'].includes(work.phase)) continue;
      const workKeys = this.workKeys(work);
      if (!workKeys.some(key => keys.includes(key))) continue;
      const waiting = this.store.records(work.id, 'question').some(row => ['pending', 'sending', 'recovering', 'uncertain'].includes(row.status));
      const verifying = this.store.records(work.id, 'verification').some(row => row.status === 'running');
      if (activeStates.has(work.state) || waiting || verifying) throw new ConflictException({ message: '연결 업무의 실행·복구·질문·승인·검증을 마친 뒤 파일·Git 작업을 진행해 주세요', workId: work.id });
    }
    // No await between state inspection and lock acquisition.
    const token = Symbol('project-operation');
    for (const key of keys) this.locks.set(key, token);
    let released = false;
    return () => {
      if (released) return; released = true;
      for (const key of keys) if (this.locks.get(key) === token) this.locks.delete(key);
    };
  }

  /** Unknown process termination remains blocked, including worktree aliases. */
  block(root: string) { for (const key of this.keys(root)) this.blocked.add(key); }
  unblock(root: string) { for (const key of this.keys(root)) this.blocked.delete(key); }
}
