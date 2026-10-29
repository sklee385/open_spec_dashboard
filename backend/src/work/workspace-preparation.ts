import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Work, WorkStore } from './store';
import { inspectWorkspacePath } from './workspace-paths';
import { assertPreparationCapacity } from './workspace-policy';
import { defaultWorkspacePolicy, type WorkspacePolicy } from './workspace-settings.service';
export type PreparationStage = 'create' | 'copy' | 'install' | 'build';
export interface PreparationOptions { policy?: () => WorkspacePolicy; freeBytes?: (path: string) => number | null; }
export class WorkspacePreparation {
  constructor(private store: WorkStore, private options: PreparationOptions = {}) {}
  private policy() {
    if (this.options.policy) return this.options.policy();
    const config = resolve(process.env.CONFIG_PATH || process.env.OPENSPEC_UI_CONFIG || '../config.local.json');
    const policy = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')).workspaces?.policy ?? defaultWorkspacePolicy : defaultWorkspacePolicy;
    if (!Number.isSafeInteger(policy.minimumFreeBytes) || policy.minimumFreeBytes < 0) throw new Error('최소 잔여 용량 설정을 확인해 주세요.');
    return policy as WorkspacePolicy;
  }
  private check(path: string) {
    let freeBytes: number | null = null;
    try {
      const ancestor = inspectWorkspacePath(path, []).ancestor;
      if (this.options.freeBytes) freeBytes = this.options.freeBytes(path);
      else { const fs = statfsSync(ancestor, { bigint: true }), free = fs.bavail * fs.bsize; if (free >= 0n && free <= BigInt(Number.MAX_SAFE_INTEGER)) freeBytes = Number(free); }
    } catch { /* Unknown free space must block preparation. */ }
    assertPreparationCapacity({ available: true, confirmed: true, freeBytes }, this.policy());
  }
  run<T>(work: Work, path: string, stage: PreparationStage, operation: () => T): T {
    const id = randomUUID(), record = { stage, executionPath: path, rootId: work.workspace?.rootId, status: 'running', startedAt: new Date().toISOString(), endedAt: null as string | null, error: null as string | null };
    this.store.record(id, work.id, 'workspace-preparation', record);
    const failed = (error: unknown): never => {
      const message = error instanceof Error ? error.message : '준비 상태를 확인할 수 없습니다.';
      record.status = 'failed'; record.error = message; record.endedAt = new Date().toISOString(); this.store.record(id, work.id, 'workspace-preparation', record);
      work.state = 'failed'; work.error = message; work.errorCode = 'workspace-preparation-failed';
      if (work.workspace) { work.workspace.status = 'failed'; work.workspace.error = message; }
      this.store.save(work);
      throw new ConflictException({ message, errorCode: 'workspace-preparation-failed' });
    };
    const finished = (value: T): T => {
      this.check(path); record.status = 'passed'; record.endedAt = new Date().toISOString(); this.store.record(id, work.id, 'workspace-preparation', record); return value;
    };
    try {
      this.check(path); const value = operation();
      if (value && typeof (value as any).then === 'function') return Promise.resolve(value).then(result => { try { return finished(result as T); } catch (error) { return failed(error); } }, failed) as T;
      return finished(value);
    } catch (error) { return failed(error); }
  }
}
