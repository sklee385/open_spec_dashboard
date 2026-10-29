import { lstatSync, readdirSync, statfsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inspectWorkspacePath } from './workspace-paths';
import type { WorkspaceRoot } from './workspace-settings.service';

type Status = 'complete' | 'partial';
interface Usage { bytes: number | null; status: Status; errors: string[]; }
interface EntityUsage { projectId: string; workspaceId: string; bytes: number; }
export interface RootCapacity extends Usage {
  rootId: string; path: string; measuredAt: string; freeBytes: number | null; skippedLinks: number;
  works: EntityUsage[]; candidates: EntityUsage[]; sharedBytes: number; otherBytes: number;
}
interface CapacityOptions {
  sharedPaths?: string[]; maxEntries?: number; maxDurationMs?: number;
  freeBytes?: (path: string) => number;
}
const diskFree = (path: string) => {
  const fs = statfsSync(path, { bigint: true }), bytes = fs.bavail * fs.bsize;
  if (bytes < 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('잔여 용량을 확인할 수 없습니다.');
  return Number(bytes);
};
/** Logical file sizes, bounded per request. No links are traversed or files removed. */
export function inspectCapacity(roots: Pick<WorkspaceRoot, 'rootId' | 'path' | 'managedPath'>[], options: CapacityOptions = {}) {
  const measuredAt = new Date().toISOString(), started = Date.now(), seen = new Set<string>();
  const shared: Usage = { bytes: null, status: 'complete', errors: [] };
  let entries = 0, exhausted = false;
  const scan = (path: string, result: Usage, account: (path: string, bytes: number) => void, link: () => void) => {
    const visit = (path: string) => {
      if (exhausted) return;
      if (++entries > (options.maxEntries ?? 100000) || Date.now() - started > (options.maxDurationMs ?? 250)) {
        exhausted = true; result.status = 'partial'; result.errors.push('집계 한도에 도달했습니다.'); return;
      }
      try {
        const stat = lstatSync(path, { bigint: true });
        if (stat.isSymbolicLink()) { link(); return; }
        if (!stat.isDirectory() && !stat.isFile()) { result.status = 'partial'; result.errors.push('일반 파일이 아닌 항목은 제외했습니다.'); return; }
        const key = stat.ino ? `${stat.dev}:${stat.ino}` : resolve(path);
        if (seen.has(key)) return; seen.add(key);
        if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) { visit(join(path, name)); if (exhausted) break; } }
        else {
          if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('파일 용량이 집계 한도를 초과했습니다.');
          account(path, Number(stat.size));
        }
      } catch (error: any) { result.status = 'partial'; result.errors.push(error.message); }
    };
    if (exhausted) { result.status = 'partial'; result.errors.push('집계 한도에 도달했습니다.'); return; }
    try { inspectWorkspacePath(path, []); visit(path); }
    catch (error: any) { result.status = 'partial'; result.errors.push(error.message); }
  };
  const results: RootCapacity[] = roots.map(root => {
    const result: RootCapacity = { rootId: root.rootId, path: root.path, measuredAt, bytes: null, status: 'complete', errors: [], freeBytes: null, skippedLinks: 0, works: [], candidates: [], sharedBytes: 0, otherBytes: 0 };
    try {
      inspectWorkspacePath(root.path, []);
      const free = (options.freeBytes ?? diskFree)(root.path);
      if (!Number.isSafeInteger(free) || free < 0) throw new Error('잔여 용량이 미확인 상태입니다.');
      result.freeBytes = free;
    } catch (error: any) { result.status = 'partial'; result.errors.push(error.message); }
    const rel = relative(resolve(root.path), resolve(root.managedPath));
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) { result.status = 'partial'; result.errors.push('관리 경로가 루트 내부가 아닙니다.'); return result; }
    scan(root.managedPath, result, (path, bytes) => {
      result.bytes = (result.bytes ?? 0) + bytes;
      const parts = relative(root.managedPath, path).split(sep);
      if (parts[0] === 'projects' && ['works', 'integrations'].includes(parts[2]) && parts[3]) {
        const list = parts[2] === 'works' ? result.works : result.candidates;
        let entity = list.find(item => item.projectId === parts[1] && item.workspaceId === parts[3]);
        if (!entity) { entity = { projectId: parts[1], workspaceId: parts[3], bytes: 0 }; list.push(entity); }
        entity.bytes += bytes;
      } else if (parts[0] === 'shared') { result.sharedBytes += bytes; shared.bytes = (shared.bytes ?? 0) + bytes; }
      else result.otherBytes += bytes;
    }, () => { result.skippedLinks++; });
    if (result.bytes === null && result.status === 'complete') result.bytes = 0;
    return result;
  });
  for (const path of options.sharedPaths ?? []) scan(path, shared, (_path, bytes) => { shared.bytes = (shared.bytes ?? 0) + bytes; }, () => {});
  if (shared.bytes === null && shared.status === 'complete') shared.bytes = 0;
  const known = results.some(root => root.bytes !== null) || shared.bytes !== null && shared.bytes > 0;
  // Root totals already include managed shared files; only add external shared usage once.
  const external = (shared.bytes ?? 0) - results.reduce((sum, root) => sum + root.sharedBytes, 0);
  return { measuredAt, status: results.some(root => root.status === 'partial') || shared.status === 'partial' ? 'partial' as const : 'complete' as const, bytes: known ? results.reduce((sum, root) => sum + (root.bytes ?? 0), 0) + external : null, roots: results, shared };
}
