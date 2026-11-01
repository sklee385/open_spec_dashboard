import { lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { runGit, GitError } from '../projects/git-runner';
import type { Work, WorkStore, WorkWorkspace } from './store';
import type { WorkspaceSettingsService } from './workspace-settings.service';
import { WorkspaceService } from './workspace.service';
import { inspectWorkspacePath } from './workspace-paths';
import { readWorkspaceRoot } from './workspace-root';
import { collectWorkspaceDocuments, copyWorkspaceDocuments, isWorkspaceDocument, documentPlanRevision } from './workspace-documents';
import { LocalPreparation, type LocalPreparationPolicy } from './local-preparation';
import { assertWorktreePointer } from './worktree-registration';
import { projectCoordinator } from '../projects/coordinator';
import type { OperationRequest } from '../projects/operation-locks';
export interface LocalBranch { name: string; commit: string; }
export interface PreparationEntry { path: string; originalPath?: string; index: string; worktree: string; untracked: boolean; }
export type GitPreparationState = 'ready' | 'branch-required' | 'not-git' | 'no-commits' | 'git-error' | 'boundary-mismatch' | 'unsupported-boundary';
export interface GitPreparation {
  state: GitPreparationState; copyEligible: boolean; reason?: string;
  root: string; commonDir: string | null; head: string | null; branch: string | null;
  selectedBranch: string | null; baseCommit: string | null; branches: LocalBranch[]; entries: PreparationEntry[];
}
interface Options { run?: (root: string, args: string[]) => Promise<Buffer>; store?: WorkStore; local?: LocalPreparation; }
export interface WorkspaceCreationRequest { requestKey: string; selectedBranch: string; baseCommit: string; sourceHead: string; }
const samePath = (a: string, b: string) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const creationRuns = new WeakMap<WorkStore, Map<string, { request: string; promise: Promise<any> }>>();
export class WorktreeManager {
  private local?: LocalPreparation;
  constructor(private options: Options = {}) {}
  private async text(root: string, args: string[]) { return (await (this.options.run ? this.options.run(root, args) : runGit(root, args, { timeoutMs: 10000, maxOutputBytes: 4 * 1024 * 1024 }))).toString('utf8'); }
  private async mutateGit(work: Work, name: string, args: string[], request: OperationRequest) {
    const store = this.options.store!, coordinator = projectCoordinator(store), resources = coordinator.operationPlan(request), id = `${work.id}:git-${name}`;
    const record = { scope: request.kind, root: request.root, commonDir: resources[0]?.commonDir, refs: resources.filter(row => row.kind === 'ref').map(row => row.ref!), affectedRoots: request.spaces ?? [request.root], status: 'running', terminationUnconfirmed: false, processTerminated: false, terminationProof: undefined as unknown, processId: undefined as number | undefined };
    store.record(id, work.id, 'workspace-git-intent', record);
    try {
      const output = this.options.run ? await this.options.run(request.root, args) : await runGit(request.root, args, { timeoutMs: 10000, maxOutputBytes: 4 * 1024 * 1024, ownedJob: true, onTermination: evidence => { record.processTerminated = true; record.terminationProof = evidence; store.record(id, work.id, 'workspace-git-intent', record); }, onSpawn: pid => { record.processId = pid; store.record(id, work.id, 'workspace-git-intent', record); } });
      store.record(id, work.id, 'workspace-git-intent', { ...record, status: 'passed' }); return output;
    } catch (error: any) {
      store.record(id, work.id, 'workspace-git-intent', { ...record, status: error instanceof GitError && !error.uncertain ? 'failed' : 'uncertain', terminationUnconfirmed: error?.terminationUnconfirmed === true && !record.processTerminated }); throw error;
    }
  }
  private recoverGitIntent(work: Work, name: string) {
    const store = this.options.store!, record = store.records(work.id, 'workspace-git-intent').find(row => row.id === `${work.id}:git-${name}`);
    if (!record || !['running', 'uncertain'].includes(record.status)) return;
    if ((record.terminationUnconfirmed || record.status === 'running') && record.processTerminated !== true) throw new ConflictException('소유 Git Job의 실제 종료 근거가 필요합니다. PID 부재로 해제하지 않습니다.');
    store.record(record.id, work.id, 'workspace-git-intent', { ...record, status: 'recovered', terminationUnconfirmed: false });
  }
  async close() { return this.local?.close(); }
  async prepareLocal(work: Work, settings: WorkspaceSettingsService, input: LocalPreparationPolicy) {
    const store = this.options.store, baseline = store?.records(work.id, 'workspace-baseline')[0], copied = store?.records(work.id, 'workspace-documents')[0];
    if (!store || baseline?.status !== 'committed' || copied?.status !== 'copied' || !work.workspace || work.workspace.workspaceBaselineCommit !== baseline.commit) throw new ConflictException('문서 기준 커밋을 먼저 확인해 주세요.');
    this.local ??= this.options.local ?? new LocalPreparation(store);
    const policy = this.local.review(work, input);
    await this.verify(work, settings); await this.assertDocumentBasis(work, copied);
    if (policy.generatedPaths.length) {
      const tracked = [...new Set((await Promise.all([
        this.text(work.projectPath, ['ls-files', '-z', '--']),
        this.text(work.executionPath!, ['ls-tree', '-r', '--name-only', '-z', baseline.commit, '--']),
      ])).flatMap(value => value.split('\0').filter(Boolean)))];
      const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
      for (const path of policy.generatedPaths) {
        const root = canonical(path);
        if (tracked.some(file => canonical(file) === root || canonical(file).startsWith(root + '/'))) throw new ConflictException('추적 중인 제품 경로는 로컬 산출물 목록으로 숨길 수 없습니다. 별도 산출물 경로를 선택해 주세요.');
      }
    }
    for (const path of policy.paths) {
      const tracked = (await this.text(work.projectPath, ['ls-files', '-z', '--', path])).split('\0').filter(Boolean);
      if (tracked.some(file => !/(^|\/)(?:\.env(?:\.[^/]+)?|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|[^/]+\.(?:pem|key|pfx|p12))$/i.test(file))) throw new ConflictException('미커밋 제품 코드는 로컬 준비 목록으로 가져올 수 없습니다. 기준을 별도로 정리해 주세요.');
      const resource = /^(node_modules|vendor|\.venv|venv|\.runtime|runtime|\.tools\/node-runtime)(\/|$)/i.test(path);
      const stat = lstatSync(join(work.projectPath, path));
      if (!resource && (stat.isDirectory() || /\.(?:ts|tsx|js|jsx|php|py|go|rs|java|c|cpp|cs|rb|vue|svelte|html|css|sqlite|sqlite3|db|log)$/i.test(path))) throw new ConflictException('제품 코드·운영 데이터·로그는 로컬 준비 목록으로 가져올 수 없습니다.');
    }
    try {
      const head = (await this.text(work.executionPath!, ['rev-parse', 'HEAD'])).trim();
      if (head !== baseline.commit || (await this.text(work.executionPath!, ['diff', '--cached', '--name-only', '-z', '--'])).length) throw new Error('로컬 준비 전 기준 또는 index가 변경되었습니다.');
      const result = await this.local.prepare(work, policy);
      await this.verify(work, settings); await this.assertDocumentBasis(work, copied);
      if ((await this.text(work.executionPath!, ['rev-parse', 'HEAD'])).trim() !== baseline.commit || (await this.text(work.executionPath!, ['diff', '--cached', '--name-only', '-z', '--'])).length) throw new Error('준비 명령이 기준 또는 index를 변경했습니다.');
      const allowed = [...policy.paths, ...policy.generatedPaths].map(path => process.platform === 'win32' ? path.toLowerCase() : path);
      const permitted = (path: string) => { const value = process.platform === 'win32' ? path.toLowerCase() : path; return allowed.some(root => value === root || value.startsWith(`${root}/`)); };
      const status = (await this.text(work.executionPath!, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0').filter(Boolean);
      for (let index = 0; index < status.length; index++) { const entry = status[index]; if (!permitted(entry.slice(3)) || /[RC]/.test(entry.slice(0, 2)) && !permitted(status[++index])) throw new Error('준비 명령이 확인한 로컬 목록 밖의 제품 파일을 변경했습니다.'); }
      return result;
    } catch (error: any) {
      work.workspace.status = 'failed'; work.workspace.error = error.message; work.state = 'failed'; work.error = error.message; work.errorCode = 'workspace-preparation-failed'; store.save(work);
      const local = store.records(work.id, 'workspace-local-preparation')[0]; if (local) store.record(local.id, work.id, 'workspace-local-preparation', { ...local, status: 'failed', error: error.message });
      throw new ConflictException(error.message);
    }
  }
  private async documentSnapshot(work: Work, selectedBranch: string) {
    const inspected = await this.inspect(work.projectPath, selectedBranch);
    if (inspected.state !== 'ready') throw new ConflictException('문서를 가져올 Git 기준을 확인해 주세요.');
    const manifest = collectWorkspaceDocuments(work.projectPath, work.changeName);
    const wanted = new Set(manifest.files.map(file => file.path));
    const removedDocuments = (await this.text(work.projectPath, ['ls-tree', '-r', '--name-only', '-z', inspected.baseCommit!, '--', `openspec/changes/${work.changeName}/`])).split('\0').filter(path => isWorkspaceDocument(path, work.changeName) && !wanted.has(path)).sort();
    const excluded = inspected.entries.flatMap(entry => [entry, ...(entry.originalPath ? [{ ...entry, path: entry.originalPath, originalPath: undefined }] : [])]).filter(entry => !isWorkspaceDocument(entry.path, work.changeName)).sort((a, b) => a.path.localeCompare(b.path));
    return { sourceHead: inspected.head, selectedBranch: inspected.selectedBranch!, baseCommit: inspected.baseCommit, documentRevision: manifest.revision, planRevision: manifest.planRevision, manifest, removedDocuments, excluded, excludedRevision: createHash('sha256').update(JSON.stringify(excluded)).digest('hex'), guidance: '필요한 코드가 기준 커밋에 없으면 별도로 보존·정리한 뒤 기준을 다시 확인해 주세요. 미커밋 제품 코드와 다른 업무 문서는 가져오지 않습니다.' };
  }
  async previewDocuments(work: Work, selectedBranch: string) {
    if (!this.options.store || !work.reviewedVersion) throw new ConflictException('문서 검토 기록과 업무 저장소가 필요합니다.');
    const snapshot = await this.documentSnapshot(work, selectedBranch);
    const preview = { ...snapshot, confirmationToken: randomUUID(), reviewedVersion: work.reviewedVersion, expiresAt: Date.now() + 5 * 60000 };
    this.options.store.record(`${work.id}:document-preview`, work.id, 'workspace-document-preview', preview);
    return preview;
  }
  async importDocuments(work: Work, settings: WorkspaceSettingsService, confirmation: any) {
    const store = this.options.store, preview = store?.records(work.id, 'workspace-document-preview')[0], intent = store?.records(work.id, 'workspace-creation')[0];
    if (!store || !preview || confirmation?.excludedConfirmed !== true || confirmation.confirmationToken !== preview.confirmationToken || preview.expiresAt <= Date.now() || preview.reviewedVersion !== work.reviewedVersion) throw new ConflictException('최신 문서와 제외 목록을 확인한 요청이 필요합니다.');
    if (!intent || intent.status !== 'created' || !work.workspace || work.workspace.kind !== 'git-worktree') throw new ConflictException('문서를 가져올 생성 공간이 없습니다.');
    const current = await this.documentSnapshot(work, intent.selectedBranch);
    if (preview.selectedBranch !== intent.selectedBranch || preview.sourceHead !== intent.sourceHead || preview.baseCommit !== intent.baseCommit || current.sourceHead !== intent.sourceHead || current.baseCommit !== intent.baseCommit || JSON.stringify(current.removedDocuments) !== JSON.stringify(preview.removedDocuments)) throw new ConflictException('확인한 문서 기준과 생성 기준이 다르거나 변경되었습니다. 다시 확인해 주세요.');
    if (current.documentRevision !== preview.documentRevision || current.excludedRevision !== preview.excludedRevision || confirmation.documentRevision !== preview.documentRevision || confirmation.excludedRevision !== preview.excludedRevision) throw new ConflictException('검토 문서 또는 제외 목록이 변경되었습니다. 다시 검토해 주세요.');
    await this.verify(work, settings);
    const previous = store.records(work.id, 'workspace-documents')[0];
    if (previous?.status === 'copied' && previous.documentRevision === preview.documentRevision && collectWorkspaceDocuments(work.executionPath!, work.changeName).revision === preview.documentRevision) return previous;
    if (work.workspace.status !== 'preparing' || (await this.text(work.executionPath!, ['rev-parse', 'HEAD'])).trim() !== intent.baseCommit || (await this.text(work.executionPath!, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length) throw new ConflictException('새 공간의 기준과 문서 상태를 확인해 복구해 주세요.');
    const id = `${work.id}:documents`, data = { documentRevision: preview.documentRevision, sourcePlanRevision: preview.planRevision, reviewedVersion: preview.reviewedVersion, manifest: preview.manifest, sourceHead: intent.sourceHead, baseCommit: intent.baseCommit, selectedBranch: intent.selectedBranch, excluded: preview.excluded, excludedRevision: preview.excludedRevision, rootId: work.workspace.rootId, workspaceId: work.workspace.workspaceId, executionPath: work.executionPath, status: 'copying' };
    store.record(id, work.id, 'workspace-documents', data);
    try {
      await new WorkspaceService(store).prepareStage(work, work.executionPath!, 'copy', async () => {
        copyWorkspaceDocuments(work.projectPath, work.executionPath!, work.changeName, preview.documentRevision);
        const after = await this.documentSnapshot(work, intent.selectedBranch);
        if (after.sourceHead !== intent.sourceHead || after.baseCommit !== intent.baseCommit) throw new Error('복사 중 Git 기준이 변경되었습니다.');
        if (after.documentRevision !== preview.documentRevision || after.excludedRevision !== preview.excludedRevision) throw new Error('복사 중 문서 또는 제외 목록이 변경되었습니다.');
        await this.verify(work, settings);
      });
      work.workspace.sourcePlanRevision = preview.planRevision; store.save(work); store.record(id, work.id, 'workspace-documents', { ...data, status: 'copied' });
      return store.records(work.id, 'workspace-documents')[0];
    } catch (error: any) {
      work.workspace.status = 'recovery-required'; work.workspace.error = error.message; store.save(work); store.record(id, work.id, 'workspace-documents', { ...data, status: 'recovery-required', error: error.message }); throw error;
    }
  }
  private async assertDocumentBasis(work: Work, copied: any) {
    const current = await this.documentSnapshot(work, copied.selectedBranch);
    if (current.sourceHead !== copied.sourceHead || current.baseCommit !== copied.baseCommit || current.documentRevision !== copied.documentRevision || current.excludedRevision !== copied.excludedRevision || work.reviewedVersion !== copied.reviewedVersion) throw new ConflictException('검토 문서 또는 Git 기준이 변경되었습니다. 다시 검토해 주세요.');
    if (collectWorkspaceDocuments(work.executionPath!, work.changeName).revision !== copied.documentRevision) throw new ConflictException('가져온 문서가 변경되었습니다. 기준 커밋 전에 재검토해 주세요.');
  }
  async commitDocuments(work: Work, settings: WorkspaceSettingsService) {
    const store = this.options.store, copied = store?.records(work.id, 'workspace-documents')[0];
    if (!store || copied?.status !== 'copied' || !work.workspace || work.workspace.kind !== 'git-worktree') throw new ConflictException('확인해 가져온 문서가 필요합니다.');
    await this.verify(work, settings); await this.assertDocumentBasis(work, copied);
    const space = work.workspace, id = `${work.id}:workspace-baseline`, previous = store.records(work.id, 'workspace-baseline')[0];
    const marker = `OpenSpecBoard-Workspace: ${space.workspaceId}\nOpenSpecBoard-Documents: ${copied.documentRevision}`;
    const verifyCommit = async (commit: string, paths: string[]) => {
      const parents = (await this.text(space.executionPath, ['rev-list', '--parents', '-n', '1', commit])).trim().split(' ');
      const message = await this.text(space.executionPath, ['log', '-1', '--format=%B', commit]);
      const changed = (await this.text(space.executionPath, ['diff', '--name-only', '-z', copied.baseCommit, commit, '--'])).split('\0').filter(Boolean);
      if (parents.length !== 2 || parents[1] !== copied.baseCommit || !message.includes(marker) || changed.some(path => !paths.includes(path) || !isWorkspaceDocument(path, work.changeName))) throw new Error('문서 전용 기준 커밋의 실제 내용을 확인할 수 없습니다.');
      const committedPaths = (await this.text(space.executionPath, ['ls-tree', '-r', '--name-only', '-z', commit, '--', `openspec/changes/${work.changeName}/`])).split('\0').filter(path => isWorkspaceDocument(path, work.changeName)).sort();
      if (JSON.stringify(committedPaths) !== JSON.stringify(copied.manifest.files.map((file: { path: string }) => file.path).sort())) throw new Error('실제 커밋의 문서 목록이 검토 manifest와 다릅니다.');
      const files: { path: string; content: Buffer }[] = [];
      for (const file of copied.manifest.files) files.push({ path: file.path, content: Buffer.from(await this.text(space.executionPath, ['cat-file', 'blob', `${commit}:${file.path}`]), 'utf8') });
      if (documentPlanRevision(files) !== copied.sourcePlanRevision) throw new Error('커밋 문서의 계획 revision이 검토 결과와 다릅니다.');
      await this.verify(work, settings); await this.assertDocumentBasis(work, copied);
      if ((await this.text(space.executionPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length) throw new Error('문서 기준 커밋 뒤 제품·문서 또는 index가 변경되었습니다.');
    };
    const save = (commit: string, record: any) => {
      store.transaction(() => { space.workspaceBaselineCommit = commit; space.sourcePlanRevision = copied.sourcePlanRevision; space.status = 'preparing'; delete space.error; if (work.errorCode === 'workspace-preparation-failed') { delete work.error; delete work.errorCode; } store.save(work); store.record(id, work.id, 'workspace-baseline', { ...record, commit, status: 'committed' }); });
      return store.records(work.id, 'workspace-baseline')[0];
    };
    if (previous) {
      if (previous.documentRevision !== copied.documentRevision || previous.reviewedVersion !== copied.reviewedVersion || previous.workspaceId !== space.workspaceId) throw new ConflictException('다른 문서 기준 저장 요청이 있습니다.');
      const head = (await this.text(space.executionPath, ['rev-parse', 'HEAD'])).trim();
      try {
        await verifyCommit(head, previous.paths);
        this.recoverGitIntent(work, 'baseline-add'); this.recoverGitIntent(work, 'baseline-commit');
        for (const record of store.records(work.id, 'workspace-preparation').filter(record => record.status === 'failed' && record.stage === 'create' && record.executionPath === space.executionPath)) store.record(record.id, work.id, 'workspace-preparation', { ...record, status: 'recovered', recoveredAt: new Date().toISOString() });
        return save(head, previous);
      } catch (error: any) {
        space.status = 'recovery-required'; space.error = error.message; store.save(work);
        store.record(id, work.id, 'workspace-baseline', { ...previous, status: 'recovery-required', error: error.message });
        throw new ConflictException('기준 커밋의 실제 상태를 확인해 복구해 주세요. 중복 커밋하지 않습니다.');
      }
    }
    const status = (await this.text(space.executionPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0').filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < status.length; index++) {
      const entry = status[index], path = entry.slice(3);
      if (!isWorkspaceDocument(path, work.changeName)) throw new ConflictException('제품 파일은 문서 기준 커밋에 포함할 수 없습니다.');
      paths.push(path);
      if (/[RC]/.test(entry.slice(0, 2))) { const original = status[++index]; if (!original || !isWorkspaceDocument(original, work.changeName)) throw new ConflictException('제품 파일 이동은 문서 기준 커밋에 포함할 수 없습니다.'); paths.push(original); }
    }
    if (space.status !== 'preparing' || (await this.text(space.executionPath, ['rev-parse', 'HEAD'])).trim() !== copied.baseCommit) throw new ConflictException('문서 기준 저장 전 HEAD를 다시 확인해 주세요.');
    const data = { workspaceId: space.workspaceId, rootId: space.rootId, executionPath: space.executionPath, baseCommit: copied.baseCommit, sourcePlanRevision: copied.sourcePlanRevision, documentRevision: copied.documentRevision, reviewedVersion: copied.reviewedVersion, paths: [...new Set(paths)].sort(), status: 'preparing' };
    store.record(id, work.id, 'workspace-baseline', data);
    try {
      let commit = '';
      await new WorkspaceService(store).prepareStage(work, space.executionPath, 'create', async () => {
        if (data.paths.length) await this.mutateGit(work, 'baseline-add', ['add', '--all', '--', ...data.paths], { kind: 'index', root: space.executionPath, commonDir: space.commonDir });
        const staged = (await this.text(space.executionPath, ['diff', '--cached', '--name-only', '-z', '--'])).split('\0').filter(Boolean);
        if (staged.some(path => !data.paths.includes(path) || !isWorkspaceDocument(path, work.changeName))) throw new Error('문서 외 stage 변경이 있어 기준 커밋을 중단했습니다.');
        await this.assertDocumentBasis(work, copied);
        const message = `OpenSpecBoard: reviewed plan for ${work.changeName}\n\n${marker}`;
        await this.mutateGit(work, 'baseline-commit', ['-c', `core.hooksPath=${join(dirname(space.executionPath), 'disabled-hooks')}`, '-c', 'commit.gpgSign=false', '-c', 'user.name=OpenSpecBoard', '-c', 'user.email=workspace@openspecboard.local', 'commit', '--allow-empty', '-m', message], { kind: 'index', root: space.executionPath, commonDir: space.commonDir });
        commit = (await this.text(space.executionPath, ['rev-parse', 'HEAD'])).trim(); await verifyCommit(commit, data.paths);
      });
      return save(commit, data);
    } catch (error: any) { space.status = 'recovery-required'; space.error = error.message; store.save(work); store.record(id, work.id, 'workspace-baseline', { ...data, status: 'recovery-required', error: error.message }); throw error; }
  }
  async create(work: Work, settings: WorkspaceSettingsService, request: WorkspaceCreationRequest) {
    const store = this.options.store;
    if (!store) throw new ConflictException('공간 생성 저장소를 확인해 주세요.');
    let runs = creationRuns.get(store); if (!runs) { runs = new Map(); creationRuns.set(store, runs); }
    const key = JSON.stringify([request?.requestKey, request?.selectedBranch, request?.baseCommit, request?.sourceHead]);
    const active = runs.get(work.id);
    if (active) { if (active.request !== key) throw new ConflictException('다른 생성 요청이 진행 중입니다.'); return active.promise; }
    const promise = this.createOnce(work, settings, request); runs.set(work.id, { request: key, promise });
    try { return await promise; } finally { if (runs.get(work.id)?.promise === promise) runs.delete(work.id); }
  }
  private async createOnce(work: Work, settings: WorkspaceSettingsService, request: WorkspaceCreationRequest) {
    const store = this.options.store;
    if (!store || !request || typeof request.requestKey !== 'string' || !request.requestKey || request.requestKey.length > 200 || typeof request.selectedBranch !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.baseCommit) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.sourceHead) || !/^[a-z0-9-]{1,80}$/.test(work.id)) throw new ConflictException('공간 생성 요청과 기준을 확인해 주세요.');
    const fingerprint = createHash('sha256').update(JSON.stringify([request.selectedBranch, request.baseCommit, request.sourceHead])).digest('hex');
    const persisted = store.get(work.id); if (!persisted) throw new ConflictException('업무가 없습니다.'); Object.assign(work, persisted);
    const previous = store.records(work.id, 'workspace-creation')[0];
    if (previous) {
      if (previous.requestKey !== request.requestKey || previous.fingerprint !== fingerprint || !work.workspace || work.workspace.kind !== 'git-worktree') throw new ConflictException('다른 생성 요청 또는 기존 공간이 있습니다.');
      try {
        await this.verify(work, settings);
        if (previous.status !== 'created') {
          if ((await this.text(work.executionPath!, ['rev-parse', 'HEAD'])).trim() !== request.baseCommit || (await this.text(work.projectPath, ['rev-parse', 'HEAD'])).trim() !== request.sourceHead || (await this.text(work.projectPath, ['rev-parse', '--verify', `refs/heads/${request.selectedBranch}^{commit}`])).trim() !== request.baseCommit) throw new Error('복구할 생성 기준이 변경되었습니다.');
          this.recoverGitIntent(work, 'create');
          work.workspace.status = 'preparing'; delete work.workspace.error; store.save(work);
          for (const record of store.records(work.id, 'workspace-preparation').filter(record => record.status === 'failed' && record.stage === 'create' && record.executionPath === work.executionPath)) store.record(record.id, work.id, 'workspace-preparation', { ...record, status: 'recovered', recoveredAt: new Date().toISOString() });
          store.record(previous.id, work.id, 'workspace-creation', { ...previous, status: 'created', recoveredAt: new Date().toISOString() });
        }
        return store.records(work.id, 'workspace-creation')[0];
      } catch (error: any) {
        work.workspace.status = 'recovery-required'; work.workspace.error = error.message; store.save(work);
        throw new ConflictException('등록·소유 정보를 확인할 수 없어 공간 복구가 필요합니다.');
      }
    }
    const inspected = await this.inspect(work.projectPath, request.selectedBranch);
    if (inspected.state !== 'ready' || inspected.head !== request.sourceHead || inspected.baseCommit !== request.baseCommit) throw new ConflictException('생성 기준 또는 프로젝트 경계가 변경되었습니다. 다시 확인해 주세요.');
    const branch = `codex/work-${work.id}`;
    if (inspected.branches.some(item => item.name === branch)) throw new ConflictException('업무 브랜치가 이미 존재합니다. 덮어쓰지 않습니다.');
    const spaces = new WorkspaceService(store), id = `${work.id}:workspace-creation`;
    store.transaction(() => {
      const space = spaces.reserve(work, settings, 'git-worktree');
      Object.assign(space, { branch, commonDir: inspected.commonDir!, baseCommit: request.baseCommit }); store.save(work);
      store.record(id, work.id, 'workspace-creation', { requestKey: request.requestKey, fingerprint, status: 'preparing', sourceHead: request.sourceHead, selectedBranch: request.selectedBranch, baseCommit: request.baseCommit, workspaceId: space.workspaceId, rootId: space.rootId, executionPath: space.executionPath, createdAt: new Date().toISOString() });
    });
    const space = work.workspace!;
    try {
      const release = projectCoordinator(store).acquirePreparation(work, { kind: 'management', root: work.projectPath, commonDir: space.commonDir, spaces: [space.executionPath], refs: [`refs/heads/${request.selectedBranch}`, `refs/heads/${branch}`] });
      try {
      await spaces.prepareStage(work, space.executionPath, 'create', async () => {
        this.boundary(work, settings);
        const container = dirname(space.executionPath);
        mkdirSync(dirname(container), { recursive: true }); inspectWorkspacePath(container, settings.protectedPaths());
        mkdirSync(container); // Exclusive container: never adopt existing paths or identity files.
        const hooks = join(container, 'disabled-hooks'); mkdirSync(hooks);
        writeFileSync(join(container, 'identity.json'), JSON.stringify({ schemaVersion: 1, workId: work.id, projectPath: work.projectPath, ...space }), { flag: 'wx' });
        const latest = await this.inspect(work.projectPath, request.selectedBranch);
        if (latest.state !== 'ready' || latest.head !== request.sourceHead || latest.baseCommit !== request.baseCommit) throw new Error('생성 직전 기준이 변경되었습니다.');
        await this.mutateGit(work, 'create', ['-c', `core.hooksPath=${hooks}`, 'worktree', 'add', '-b', branch, '--', space.executionPath, request.baseCommit], { kind: 'management', root: work.projectPath, commonDir: space.commonDir, spaces: [space.executionPath], refs: [`refs/heads/${request.selectedBranch}`, `refs/heads/${branch}`] });
        await this.verify(work, settings);
        if ((await this.text(space.executionPath, ['rev-parse', 'HEAD'])).trim() !== request.baseCommit || (await this.text(work.projectPath, ['rev-parse', 'HEAD'])).trim() !== request.sourceHead || (await this.text(work.projectPath, ['rev-parse', '--verify', `refs/heads/${request.selectedBranch}^{commit}`])).trim() !== request.baseCommit) throw new Error('생성 중 기준이 변경되었습니다.');
      });
      } finally { release(); }
      const intent = store.records(work.id, 'workspace-creation')[0]; store.record(id, work.id, 'workspace-creation', { ...intent, status: 'created' });
      return store.records(work.id, 'workspace-creation')[0];
    } catch (error: any) {
      space.status = 'recovery-required'; space.error = error.message; store.save(work);
      const intent = store.records(work.id, 'workspace-creation')[0]; store.record(id, work.id, 'workspace-creation', { ...intent, status: 'recovery-required', error: error.message });
      throw error;
    }
  }
  private boundary(work: Work, settings: WorkspaceSettingsService) {
    const space = work.workspace;
    if (!space || space.version !== 1 || space.kind !== 'git-worktree' || work.executionPath !== space.executionPath || !/^[a-f0-9]{64}$/.test(space.projectId) || !/^[a-f0-9-]{36}$/.test(space.workspaceId) || space.branch !== `codex/work-${work.id}`) throw new Error('공간 식별 불일치');
    const root = readWorkspaceRoot(space.rootPath, settings.protectedPaths(), space.profileId);
    if (root.rootId !== space.rootId || root.managedPath !== space.managedPath || space.executionPath !== join(root.managedPath, 'projects', space.projectId, 'works', space.workspaceId, 'project')) throw new Error('루트 식별 불일치');
    inspectWorkspacePath(space.executionPath, [...settings.protectedPaths(), work.projectPath]);
    return space;
  }
  async verify(work: Work, settings: WorkspaceSettingsService) {
    const space = this.boundary(work, settings), identityPath = join(dirname(space.executionPath), 'identity.json');
    if (!space.commonDir) throw new Error('Git 공통 경계 정보가 없습니다.');
    assertWorktreePointer(space.executionPath, space.commonDir);
    const pointer = lstatSync(join(space.executionPath, '.git'));
    if (!pointer.isFile() || pointer.isSymbolicLink() || pointer.nlink !== 1 || pointer.size > 8192) throw new Error('Git 관리 포인터가 일반 소유 파일이 아닙니다.');
    const stat = lstatSync(identityPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error('소유 식별 파일 오류');
    const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
    for (const key of ['kind', 'profileId', 'rootId', 'workspaceId', 'projectId', 'executionPath', 'commonDir', 'branch']) if (identity[key] !== space[key as keyof WorkWorkspace]) throw new Error('공간 소유 불일치');
    if (identity.schemaVersion !== 1 || identity.workId !== work.id || identity.projectPath !== work.projectPath) throw new Error('업무 소유 불일치');
    const common = realpathSync((await this.text(work.projectPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    const ownedCommon = realpathSync((await this.text(space.executionPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
    if (!space.commonDir || !samePath(common, space.commonDir) || !samePath(common, ownedCommon)) throw new Error('Git 공통 디렉터리 불일치');
    const listing = (await this.text(work.projectPath, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').map(group => Object.fromEntries(group.split('\0').filter(Boolean).map(field => { const index = field.indexOf(' '); return index < 0 ? [field, true] : [field.slice(0, index), field.slice(index + 1)]; })));
    const registration = listing.find(item => typeof item.worktree === 'string' && samePath(item.worktree, space.executionPath));
    const head = (await this.text(space.executionPath, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    const branch = (await this.text(space.executionPath, ['symbolic-ref', 'HEAD'])).trim();
    if (!registration || registration.locked || registration.prunable || registration.branch !== `refs/heads/${space.branch}` || branch !== registration.branch || head !== registration.HEAD) throw new Error('Git worktree 등록·브랜치 불일치');
  }
  async inspect(projectPath: string, selectedBranch?: string): Promise<GitPreparation> {
    const result: GitPreparation = { state: 'git-error', copyEligible: false, root: projectPath, commonDir: null, head: null, branch: null, selectedBranch: null, baseCommit: null, branches: [], entries: [] };
    const stop = (state: GitPreparationState, reason: string): GitPreparation => ({ ...result, state, reason, copyEligible: state === 'not-git' || state === 'no-commits' });
    try {
      const stat = lstatSync(projectPath), canonical = realpathSync(projectPath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(canonical, projectPath)) return stop('boundary-mismatch', '등록 프로젝트의 실제 경계와 경로가 다릅니다.');
      result.root = canonical;
      let bare: string;
      try { bare = (await this.text(canonical, ['rev-parse', '--is-bare-repository'])).trim(); }
      catch (error) { if (error instanceof GitError && error.status !== 503 && /not a git repository/i.test(error.message)) return stop('not-git', 'Git 저장소가 아니므로 복사 방식을 사용합니다.'); throw error; }
      if (bare === 'true') return stop('unsupported-boundary', 'bare 저장소는 업무 실행 경계로 지원하지 않습니다.');
      const top = realpathSync((await this.text(canonical, ['rev-parse', '--show-toplevel'])).trim());
      if (!samePath(top, canonical)) return stop('boundary-mismatch', '등록 프로젝트와 Git 최상위 경계가 일치해야 합니다.');
      result.commonDir = realpathSync(resolve(canonical, (await this.text(canonical, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()));
      const superproject = (await this.text(canonical, ['rev-parse', '--show-superproject-working-tree'])).trim();
      const index = await this.text(canonical, ['ls-files', '--stage', '-z']);
      if (superproject || index.split('\0').some(entry => entry.startsWith('160000 '))) return stop('unsupported-boundary', 'submodule 경계는 자동 처리하지 않습니다.');
      const refs = await this.text(canonical, ['for-each-ref', '--format=%(refname:lstrip=2)%00%(objectname)', 'refs/heads/']);
      result.branches = refs.trim().split('\n').filter(Boolean).map(line => { const [name, commit] = line.split('\0'); if (!name || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error('로컬 브랜치 정보를 확인할 수 없습니다.'); return { name, commit }; }).sort((a, b) => a.name.localeCompare(b.name));
      try { result.branch = (await this.text(canonical, ['symbolic-ref', '--short', 'HEAD'])).trim(); }
      catch (error) { if (!(error instanceof GitError) || !/not a symbolic ref/i.test(error.message)) throw error; }
      try { result.head = (await this.text(canonical, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim(); }
      catch (error) {
        if (error instanceof GitError && result.branch && !result.branches.some(branch => branch.name === result.branch) && /Needed a single revision|unknown revision|bad revision/i.test(error.message)) return stop('no-commits', '現在のHEADに初期コミットがないためコピー方式を使用します。');
        throw error;
      }
      const status = (await this.text(canonical, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
      for (let i = 0; i < status.length; i++) {
        const entry = status[i]; if (!entry) continue;
        const item: PreparationEntry = { path: entry.slice(3), index: entry[0], worktree: entry[1], untracked: entry.startsWith('??') };
        if (/[RC]/.test(entry.slice(0, 2))) item.originalPath = status[++i];
        result.entries.push(item);
      }
      const selected = result.branches.find(branch => branch.name === (selectedBranch ?? result.branch));
      if (!selected) return stop('branch-required', '기준으로 사용할 로컬 브랜치를 명시적으로 선택해 주세요.');
      result.selectedBranch = selected.name; result.baseCommit = selected.commit; result.state = 'ready';
      return result;
    } catch (error: any) { return stop('git-error', error.message || 'Git 사전 점검에 실패했습니다.'); }
  }
}
