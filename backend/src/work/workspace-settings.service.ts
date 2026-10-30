import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { LegacyService } from '../legacy/legacy.service';
import { inspectWorkspacePath, type WorkspacePathInspection } from './workspace-paths';
import { probeWorkspacePath, readWorkspaceRoot, registerWorkspaceRoot } from './workspace-root';
import { gitCommonDirectory } from '../projects/git-metadata';
import { WorkStore } from './store';
import { projectCoordinator } from '../projects/coordinator';
import { assertActiveCapacity } from './workspace-policy';
import { workspaceMaintenance } from './workspace-maintenance';

export interface WorkspaceRoot { rootId: string; path: string; managedPath: string; confirmedAt: string; }
export interface WorkspacePolicy { maxActiveWorks: number; minimumFreeBytes: number; retentionDays: number; }
export interface WorkspaceSettings {
  schemaVersion: 1; profileId: string; version: number; roots: WorkspaceRoot[];
  selectedRootId?: string; policy: WorkspacePolicy;
}
export const defaultWorkspacePolicy: WorkspacePolicy = { maxActiveWorks: 3, minimumFreeBytes: 5 * 1024 ** 3, retentionDays: 14 };
interface PathCheck { inspection: WorkspacePathInspection; version: number; profileId: string; environment?: string; expiresAt: number; }
@Injectable()
export class WorkspaceSettingsService {
  private readonly checks = new Map<string, PathCheck>();
  constructor(@Inject(LegacyService) private legacy: LegacyService, @Inject(WorkStore) private store?: WorkStore) {
    if (store) projectCoordinator(store).setActivityGuard(work => assertActiveCapacity(work, this.read().policy, store));
  }
  savePolicy(body: any) {
    const policy = body?.policy;
    if (!policy || !Number.isSafeInteger(policy.maxActiveWorks) || policy.maxActiveWorks < 1 || !Number.isSafeInteger(policy.minimumFreeBytes) || policy.minimumFreeBytes < 0 || !Number.isSafeInteger(policy.retentionDays) || policy.retentionDays < 1) throw new BadRequestException('업무 수·잔여 용량·보존 기간을 올바른 정수로 입력해 주세요.');
    this.update(body.version, settings => { settings.policy = { maxActiveWorks: policy.maxActiveWorks, minimumFreeBytes: policy.minimumFreeBytes, retentionDays: policy.retentionDays }; });
    return this.view();
  }
  maintenance(query:Record<string,unknown>={}) { if(!this.store)throw new ConflictException('업무 저장소를 확인할 수 없습니다');return workspaceMaintenance(this.store,this.read(),query); }
  history() {
    if (!this.store) throw new ConflictException('업무 참조 저장소를 확인할 수 없습니다.');
    const settings = this.read();
    return { version: settings.version, selectedRootId: settings.selectedRootId, roots: settings.roots.map(root => ({ ...root, selected: root.rootId === settings.selectedRootId, references: this.store!.rootReferences(root.rootId, root.path) })) };
  }
  unregister(rootId: string, body: any) {
    if (!this.store) throw new ConflictException('업무 참조 저장소를 확인할 수 없습니다.');
    this.update(body?.version, settings => {
      const root = settings.roots.find(root => root.rootId === rootId);
      if (!root) throw new BadRequestException('등록된 루트가 아닙니다.');
      if (settings.selectedRootId === rootId || process.env.WORKSPACE_ROOT && this.samePath(process.env.WORKSPACE_ROOT, root.path)) throw new ConflictException('현재 사용 중인 루트는 등록 해제할 수 없습니다.');
      if (this.store!.rootReferences(rootId, root.path).length) throw new ConflictException('업무 또는 후보가 참조하는 루트는 등록 해제할 수 없습니다.');
      settings.roots = settings.roots.filter(root => root.rootId !== rootId);
    });
    return this.history();
  }
  withSelectedRoot<T>(action: (selection: ReturnType<WorkspaceSettingsService['view']>) => T): T {
    this.read();
    // Share the settings lock with root switches/unregistration while persisting intent.
    return this.legacy.updateConfig(() => action(this.view()));
  }
  read(): WorkspaceSettings {
    const saved = this.legacy.config().workspaces;
    if (saved !== undefined) return this.validate(saved);
    return this.legacy.updateConfig(config => {
      config.workspaces ??= { schemaVersion: 1, profileId: randomUUID(), version: 0, roots: [], policy: { ...defaultWorkspacePolicy } };
      return this.validate(config.workspaces);
    });
  }
  protectedPaths(): string[] {
    const projects = this.legacy.sources().map(source => dirname(source.path));
    return [resolve(__dirname, '../../..'), dirname(this.legacy.configPath), resolve(process.env.DATA_DIR || '../.data'), ...projects, ...projects.flatMap(root => { const common = gitCommonDirectory(root); return common ? [common] : []; })];
  }
  view() {
    const settings = this.read(), environment = process.env.WORKSPACE_ROOT;
    const selected = settings.roots.find(root => root.rootId === settings.selectedRootId);
    let path = environment || selected?.path || null;
    const source = environment ? 'environment' : selected ? 'saved' : 'unset';
    let confirmed = false;
    let available = false, freeBytes: number | null = null, error: string | null = null;
    if (path) {
      try {
        const inspection = inspectWorkspacePath(path, this.protectedPaths());
        path = inspection.path;
        confirmed = !!selected && this.samePath(path, selected.path);
        if (confirmed && readWorkspaceRoot(selected!.path, this.protectedPaths(), settings.profileId).rootId !== selected!.rootId) throw new ConflictException('관리 공간의 루트 소유 정보가 변경되었습니다.');
        available = inspection.exists;
        const fs = statfsSync(inspection.ancestor, { bigint: true }), free = fs.bavail * fs.bsize;
        if (free <= BigInt(Number.MAX_SAFE_INTEGER)) freeBytes = Number(free);
      } catch (e: any) { error = e.message; }
    }
    return { ...settings, path, managedPath: path ? join(path, `openspecboard-${settings.profileId}`) : null, source, editable: !environment, confirmed, available, freeBytes, error };
  }
  check(body: any) {
    const settings = this.read();
    if (body?.version !== settings.version) throw new ConflictException('다른 창에서 설정이 변경되었습니다. 초안을 보존하고 최신 설정을 확인해 주세요.');
    const environment = process.env.WORKSPACE_ROOT;
    const inspection = inspectWorkspacePath(body?.path, this.protectedPaths());
    if (environment && !this.samePath(inspection.path, inspectWorkspacePath(environment, this.protectedPaths()).path)) throw new ConflictException('WORKSPACE_ROOT 환경 설정으로 경로가 고정되어 있습니다.');
    probeWorkspacePath(inspection);
    const expiresAt = Date.now() + 5 * 60_000, token = randomUUID();
    for (const [key, value] of this.checks) if (value.expiresAt <= Date.now()) this.checks.delete(key);
    if (this.checks.size >= 100) throw new ConflictException('미확인 검사가 너무 많습니다. 잠시 후 다시 검사해 주세요.');
    this.checks.set(token, { inspection, version: settings.version, profileId: settings.profileId, environment, expiresAt });
    return { token, version: settings.version, path: inspection.path, managedPath: join(inspection.path, `openspecboard-${settings.profileId}`), expiresAt: new Date(expiresAt).toISOString(), createsPath: !inspection.exists };
  }
  save(body: any) {
    if (body?.confirmed !== true || typeof body.token !== 'string') throw new BadRequestException('검사 결과의 경로와 생성 범위를 확인한 뒤 저장해 주세요.');
    const check = this.checks.get(body.token);
    if (!check || check.expiresAt <= Date.now() || check.version !== body.version || check.environment !== process.env.WORKSPACE_ROOT) throw new ConflictException('검사 토큰이 만료되었거나 설정이 바뀌었습니다. 다시 검사해 주세요.');
    this.update(body.version, settings => {
      if (settings.profileId !== check.profileId) throw new ConflictException('프로필이 변경되었습니다. 다시 검사해 주세요.');
      const root = registerWorkspaceRoot(check.inspection, this.protectedPaths(), settings.profileId);
      const previous = settings.roots.find(entry => entry.path === root.path);
      if (previous && previous.rootId !== root.rootId) throw new ConflictException('기존 루트 소유 정보가 변경되었습니다.');
      if (!previous) settings.roots.push(root);
      settings.selectedRootId = root.rootId;
    });
    this.checks.delete(body.token);
    return this.view();
  }
  update(version: number, change: (draft: WorkspaceSettings) => void): WorkspaceSettings {
    return this.legacy.updateConfig(config => {
      const settings = this.validate(config.workspaces);
      if (version !== settings.version) throw new ConflictException('다른 창에서 설정이 변경되었습니다. 초안을 보존하고 최신 설정을 다시 확인해 주세요.');
      change(settings); settings.version++;
      config.workspaces = this.validate(settings);
      return config.workspaces;
    });
  }
  private samePath(a: string, b: string) { return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b); }
  private validate(value: unknown): WorkspaceSettings {
    const saved = value as WorkspaceSettings | undefined;
    if (!saved || saved.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(saved.profileId) || !Number.isSafeInteger(saved.version) || saved.version < 0 || !Array.isArray(saved.roots) || !saved.policy || !Number.isSafeInteger(saved.policy.maxActiveWorks) || saved.policy.maxActiveWorks < 1 || !Number.isSafeInteger(saved.policy.minimumFreeBytes) || saved.policy.minimumFreeBytes < 0 || !Number.isSafeInteger(saved.policy.retentionDays) || saved.policy.retentionDays < 1) throw new ConflictException('작업 공간 설정이 손상되었거나 지원하지 않는 버전입니다. 원본 설정을 확인해 주세요.');
    const ids = new Set<string>(), paths = new Set<string>();
    for (const root of saved.roots) {
      if (!root || !/^[a-f0-9-]{36}$/.test(root.rootId) || typeof root.path !== 'string' || !isAbsolute(root.path) || root.managedPath !== join(root.path, `openspecboard-${saved.profileId}`) || !Number.isFinite(Date.parse(root.confirmedAt)) || ids.has(root.rootId) || paths.has(process.platform === 'win32' ? root.path.toLowerCase() : root.path)) throw new ConflictException('작업 공간 루트 설정이 손상되었습니다. 원본 설정을 확인해 주세요.');
      ids.add(root.rootId); paths.add(process.platform === 'win32' ? root.path.toLowerCase() : root.path);
    }
    if (saved.selectedRootId !== undefined && !ids.has(saved.selectedRootId)) throw new ConflictException('선택한 루트 설정이 손상되었습니다.');
    return saved;
  }
}
