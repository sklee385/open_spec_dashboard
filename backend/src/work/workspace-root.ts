import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectWorkspacePath, type WorkspacePathInspection } from './workspace-paths';
import type { WorkspaceRoot } from './workspace-settings.service';

export function probeWorkspacePath(inspection: WorkspacePathInspection): void {
  const path = join(inspection.ancestor, `.openspecboard-probe-${randomUUID()}`), nonce = randomUUID();
  const fd = openSync(path, 'wx+');
  const identity = fstatSync(fd, { bigint: true });
  try {
    writeFileSync(fd, nonce);
    const buffer = Buffer.alloc(Buffer.byteLength(nonce));
    if (readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length || buffer.toString() !== nonce) throw new ConflictException('공간 읽기/쓰기 검사를 확인하지 못했습니다.');
  } finally {
    try {
      const current = lstatSync(path, { bigint: true });
      if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw new ConflictException('검사 파일이 교체되었습니다. 기존 내용을 보존했습니다.');
      unlinkSync(path);
    } finally { closeSync(fd); }
  }
}
export function registerWorkspaceRoot(inspection: WorkspacePathInspection, protectedPaths: string[], profileId: string): WorkspaceRoot {
  if (!/^[a-f0-9-]{36}$/.test(profileId)) throw new ConflictException('프로필 식별이 잘못되었습니다.');
  const current = inspectWorkspacePath(inspection.path, protectedPaths);
  if (current.fingerprint !== inspection.fingerprint) throw new ConflictException('검사 후 경로가 변경되었습니다. 다시 검사해 주세요.');
  // This function is called only after an explicit confirmation, inside the config lock.
  mkdirSync(current.path, { recursive: true });
  const rootCheck = inspectWorkspacePath(current.path, protectedPaths);
  probeWorkspacePath(rootCheck);
  const managedPath = join(current.path, `openspecboard-${profileId}`);
  let created = false;
  try { mkdirSync(managedPath); created = true; }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  inspectWorkspacePath(managedPath, protectedPaths);
  const identityPath = join(managedPath, 'identity.json');
  if (created) {
    const root: WorkspaceRoot = { rootId: randomUUID(), path: current.path, managedPath, confirmedAt: new Date().toISOString() };
    writeFileSync(identityPath, JSON.stringify({ schemaVersion: 1, profileId, ...root }, null, 2), { flag: 'wx' });
    return root;
  }
  return readWorkspaceRoot(current.path, protectedPaths, profileId);
}
export function readWorkspaceRoot(path: string, protectedPaths: string[], profileId: string): WorkspaceRoot {
  const managedPath = join(path, `openspecboard-${profileId}`), identityPath = join(managedPath, 'identity.json');
  inspectWorkspacePath(managedPath, protectedPaths);
  try {
    const stat = lstatSync(identityPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('identity file');
    const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
    if (identity.schemaVersion !== 1 || identity.profileId !== profileId || !/^[a-f0-9-]{36}$/.test(identity.rootId) || identity.path !== path || identity.managedPath !== managedPath || !Number.isFinite(Date.parse(identity.confirmedAt))) throw new Error('ownership');
    return { rootId: identity.rootId, path, managedPath, confirmedAt: identity.confirmedAt };
  } catch { throw new ConflictException('기존 관리 폴더의 소유권을 확인할 수 없습니다. 기존 파일을 보존했습니다.'); }
}
