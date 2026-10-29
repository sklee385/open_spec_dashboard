import { ConflictException } from '@nestjs/common';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Work, WorkStore } from '../work/store';
import { gitCommonDirectory, gitHeadRef, resolveGitRef } from './git-metadata';
export type OperationScope = 'documents' | 'workspace' | 'index' | 'management' | 'integration';
export interface OperationRequest { kind: OperationScope; root: string; changeName?: string; spaces?: string[]; refs?: string[]; commonDir?: string; }
export interface OperationResource { key: string; kind: 'integration' | 'management' | 'space' | 'document' | 'ref'; root: string; commonDir: string; ref?: string; order: number; }
const active = new Set(['connecting', 'creating-thread', 'running', 'waiting-input', 'waiting-approval', 'recovery-required']);
const canonical = (path: string) => { let value: string; try { value = realpathSync(path); } catch { value = resolve(path); } return process.platform === 'win32' ? value.toLowerCase() : value; };
const overlaps = (a: string, b: string) => { const inside = (x: string, y: string) => { const rel = relative(x, y); return !rel || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); }; return inside(a, b) || inside(b, a); };
const sorted = (a: OperationResource, b: OperationResource) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
function conflict(a: OperationResource, b: OperationResource) {
  if (['space', 'document'].includes(a.kind) && ['space', 'document'].includes(b.kind)) return overlaps(a.root, b.root);
  if (a.kind === 'ref' && b.kind === 'ref' && a.commonDir === b.commonDir && (!a.ref || !b.ref)) return true;
  return a.key === b.key;
}
/** Scope-aware locks; acquisition is atomic and never waits while holding another scope. */
export class ScopedOperationLocks {
  private held = new Map<symbol, { owner?: string; resources: OperationResource[] }>();
  constructor(private store: WorkStore, private recordsDirectory: string, private legacyBlocked: (resources: OperationResource[]) => boolean) {}
  plan(request: OperationRequest, frozenRefs = false): OperationResource[] {
    if (!request || !['documents', 'workspace', 'index', 'management', 'integration'].includes(request.kind) || typeof request.root !== 'string' || !isAbsolute(request.root) || request.commonDir !== undefined && (typeof request.commonDir !== 'string' || !isAbsolute(request.commonDir))) throw new ConflictException('잠금 범위와 절대 경로를 확인해 주세요.');
    const root = canonical(request.root), common = canonical(request.commonDir ?? gitCommonDirectory(root) ?? root), resources: OperationResource[] = [];
    const add = (kind: OperationResource['kind'], path: string, order: number, ref?: string) => resources.push({ key: `${kind}:${path}${ref ? `:${ref}` : ''}`, kind, root: path, commonDir: common, order, ...(ref ? { ref } : {}) });
    if (request.kind === 'integration') add('integration', common, 0);
    if (['management', 'integration'].includes(request.kind)) add('management', common, 1);
    if (request.kind === 'documents') {
      if (!request.changeName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.changeName)) throw new ConflictException('변경 문서 식별을 확인해 주세요.');
      add('document', canonical(join(root, 'openspec/changes', request.changeName)), 2);
    }
    if (['workspace', 'index', 'integration'].includes(request.kind)) add('space', root, 2);
    for (const path of request.spaces ?? []) { if (typeof path !== 'string' || !isAbsolute(path)) throw new ConflictException('영향 공간 경로를 확인해 주세요.'); add('space', canonical(path), 2); }
    let refs = request.refs ?? [];
    if (!frozenRefs && ['workspace', 'index', 'integration'].includes(request.kind)) {
      try { refs = [...refs, ...[gitHeadRef(root)].filter((value): value is string => !!value)]; }
      catch { throw new ConflictException('Git HEAD/ref 소유를 확인한 뒤 새 작업을 시작해 주세요.'); }
    }
    for (let ref of refs) {
      if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.length > 1024 || /[\0\r\n\\:*?\[\]~^ ]/.test(ref)) throw new ConflictException('Git ref 잠금 식별을 확인해 주세요.');
      if (!frozenRefs && gitCommonDirectory(root)) {
        try { ref = resolveGitRef(root, ref); } catch { throw new ConflictException('Git 대상 ref 소유를 확인해 주세요.'); }
      }
      add('ref', common, 3, process.platform === 'win32' ? ref.toLowerCase() : ref);
    }
    return [...new Map(resources.map(resource => [resource.key, resource])).values()].sort(sorted);
  }
  private workRequest(work: Work): OperationRequest {
    const root = work.executionPath ?? work.workspace?.executionPath ?? work.projectPath;
    return ['implementation', 'verification'].includes(work.phase) || work.workspace?.status === 'preparing'
      ? { kind: 'workspace', root, commonDir: work.workspace?.commonDir }
      : { kind: 'documents', root, changeName: work.changeName };
  }
  private busy(work: Work) {
    return active.has(work.state) || work.workspace?.status === 'preparing' || this.store.records(work.id, 'question').some(row => ['pending', 'sending', 'recovering', 'uncertain'].includes(row.status)) || ['verification', 'browser-verification'].some(kind => this.store.records(work.id, kind).some(row => row.status === 'running'));
  }
  private observed(request: OperationRequest): OperationResource[] {
    try { return this.plan(request); }
    catch {
      // Lost HEAD cannot disclose the held ref. Keep its own space and shared refs
      // blocked without turning damage in another repository into a global lock.
      const resources = this.plan({ ...request, refs: [] }, true);
      if (request.kind !== 'documents') {
        const common = canonical(request.commonDir ?? gitCommonDirectory(request.root) ?? request.root);
        resources.push({ key: `ref:${common}`, kind: 'ref', root: common, commonDir: common, order: 3 });
      }
      return resources;
    }
  }
  private persisted(resources: OperationResource[]) {
    let names: string[];
    try { names = readdirSync(this.recordsDirectory).filter(name => name.endsWith('.json')); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw new ConflictException('Git 작업 기록을 확인할 수 없습니다.'); }
    if (names.length > 10000) throw new ConflictException('Git 작업 기록 정리가 필요합니다.');
    for (const name of names) {
      let row: any;
      try { const path = join(this.recordsDirectory, name), stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error(); row = JSON.parse(readFileSync(path, 'utf8')); if (typeof row.root !== 'string' || !isAbsolute(row.root)) throw new Error(); }
      catch { throw new ConflictException('Git 작업 기록이 손상되어 실제 상태 확인이 필요합니다.'); }
      if (row.reviewedAt || !['running', 'uncertain'].includes(row.state || row.status)) continue;
      if (['documents', 'workspace', 'index', 'management', 'integration'].includes(row.scope)) {
        const recorded = this.plan({ kind: row.scope, root: row.root, commonDir: row.commonDir, refs: row.refs ?? [], spaces: row.affectedRoots, changeName: row.changeName }, true);
        if (resources.some(resource => recorded.some(saved => conflict(resource, saved)))) throw new ConflictException('영향 공간에 미확인 Git 작업이 남아 있습니다. 실제 상태를 확인해 주세요.');
      } else {
        // Old intents have no trustworthy scope: preserve their original common-dir guard.
        const common = row.commonDir ? canonical(row.commonDir) : null, root = canonical(row.root);
        if (resources.some(resource => overlaps(resource.root, root) || common !== null && resource.commonDir === common)) throw new ConflictException('범위가 없는 과거 미확인 Git 작업을 먼저 확인해 주세요.');
      }
    }
  }
  private storedWork(resources: OperationResource[]) {
    for (const work of this.store.list()) {
      for (const row of this.store.records(work.id, 'workspace-git-intent').filter(row => ['running', 'uncertain'].includes(row.status))) {
        const recorded = this.plan({ kind: row.scope, root: row.root, commonDir: row.commonDir, refs: row.refs ?? [], spaces: row.affectedRoots }, true);
        if (resources.some(resource => recorded.some(saved => conflict(resource, saved)))) throw new ConflictException('영향 공간의 Git 프로세스 또는 결과가 미확인입니다. 실제 상태를 복구해 주세요.');
      }
      for (const process of this.store.records(work.id, 'workspace-local-process').filter(row => ['running', 'uncertain'].includes(row.status))) {
        const recorded = this.observed({ kind: 'workspace', root: process.executionPath || work.executionPath || work.projectPath, commonDir: work.workspace?.commonDir });
        if (resources.some(resource => recorded.some(existing => conflict(resource, existing)))) throw new ConflictException('해당 공간의 준비 프로세스 종료가 미확인입니다.');
      }
    }
  }
  assertRecovery(request: OperationRequest) { const resources = this.plan(request); this.persisted(resources); this.storedWork(resources); }
  assert(request: OperationRequest, owner?: string, checkActive = true, ownWorkId?: string) {
    const resources = this.plan(request), sameOwner = [...this.held.values()].filter(held => owner && held.owner === owner).flatMap(held => held.resources).sort(sorted);
    if (sameOwner.length && resources.some(resource => sorted(resource, sameOwner.at(-1)!) < 0)) throw new ConflictException('통합→관리→정렬 공간의 잠금 취득 순서를 지켜 주세요.');
    if (this.legacyBlocked(resources) || [...this.held.values()].some(held => resources.some(resource => held.resources.some(existing => conflict(resource, existing))))) throw new ConflictException('해당 공간 또는 공유 관리/ref 작업이 진행 중입니다.');
    this.persisted(resources);
    this.storedWork(resources);
    for (const work of this.store.list()) {
      if (work.id !== ownWorkId && !['completed', 'archived'].includes(work.phase) && checkActive && this.busy(work) && resources.some(resource => this.observed(this.workRequest(work)).some(existing => conflict(resource, existing)))) throw new ConflictException({ message: '같은 업무 공간의 실행·질문·승인·검증을 마친 뒤 요청해 주세요.', workId: work.id });
    }
    return resources;
  }
  acquire(request: OperationRequest, owner?: string, ownWorkId?: string) {
    const resources = this.assert(request, owner, true, ownWorkId), token = Symbol('scoped-operation'); this.held.set(token, { owner, resources });
    let released = false; return () => { if (!released) { released = true; this.held.delete(token); } };
  }
  conflictsWithLegacy(root: string, common?: string) {
    const path = canonical(root), shared = common ? canonical(common) : null;
    return [...this.held.values()].some(held => held.resources.some(resource => overlaps(resource.root, path) || shared !== null && resource.commonDir === shared));
  }
}
