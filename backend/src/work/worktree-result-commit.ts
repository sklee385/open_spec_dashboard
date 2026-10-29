import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, fstatSync, mkdirSync, openSync, closeSync, writeFileSync, readFileSync, realpathSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ProjectGit } from '../projects/git';
import { GitError, runGit } from '../projects/git-runner';
import { projectCoordinator } from '../projects/coordinator';
import type { WorkStore, IntegrationRequest, Work } from './store';
import type { WorkService } from './work.service';
import { managedPrivatePath, workspaceResourcePath, workspaceSourcePolicy } from './workspace-file-policy';
import { DesktopLifecycle } from '../desktop/lifecycle';
import { excludedNames } from './file-results';
import { inspectWorkspacePath } from './workspace-paths';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ownedRead(root: string, path: string) {
  const absolute = join(root, path), before = lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || resolve(realpathSync(absolute)).toLowerCase() !== resolve(absolute).toLowerCase()) throw new ConflictException('독립 일반 파일만 커밋할 수 있습니다.');
  if (before.size > 8 * 1024 * 1024) throw new ConflictException(`선택 커밋 파일 크기 한도(8 MiB)를 초과했습니다: ${path}`);
  const fd = openSync(absolute, 'r');
  try {
    const opened = fstatSync(fd); if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) throw new ConflictException('소스 파일 소유가 변경되었습니다.');
    const content = readFileSync(fd), after = lstatSync(absolute);
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1 || after.isSymbolicLink()) throw new ConflictException('읽는 중 소스 파일이 변경되었습니다.');
    return content;
  } finally { closeSync(fd); }
}
type Input = { integrationId: string; requestKey: string; confirmed: true; previewVersion: string; paths: string[]; message: string };
type Entry = { path: string; originalPath?: string; index: string; worktree: string; untracked: boolean; selectable: boolean; partial: boolean };
export class WorktreeResultCommit {
  constructor(private store: WorkStore, private works: WorkService, private lifecycle: DesktopLifecycle) {}
  private run(root: string, args: string[]) { return runGit(root, ['-c', 'core.fsmonitor=false', ...args]); }
  private async text(root: string, args: string[]) { return (await this.run(root, args)).toString('utf8').trim(); }
  private excluded(work: Work, path: string) { return workspaceResourcePath(work, path) || path.split('/').some(part => excludedNames.includes(part.toLowerCase())) || path.endsWith('.tsbuildinfo'); }
  private assertPolicy(work: Work) {
    const space = work.workspace;
    if (!space?.preparationPolicyDigest && !space?.localOnlyPaths?.length) return;
    const policy = this.store.records(work.id, 'workspace-local-policy').at(-1), prepared = this.store.records(work.id, 'workspace-local-preparation').at(-1);
    if (!space.preparationPolicyDigest || policy?.policyDigest !== space.preparationPolicyDigest || policy.confirmed !== true || prepared?.policyDigest !== space.preparationPolicyDigest || prepared.status !== 'ready' || hash([...(policy.paths ?? []), ...(policy.generatedPaths ?? [])].sort()) !== hash([...(space.localOnlyPaths ?? [])].sort())) throw new ConflictException('검토한 고정 로컬 준비 정책과 제외 목록을 확인해 주세요.');
  }
  /** Check attributes without status/diff: those commands may invoke clean conversion. */
  private async assertConversions(work: Work) {
    this.assertPolicy(work);
    const root = this.works.execution.executionPath(work);
    const flags = (await this.run(root, ['ls-files', '-v', '-z'])).toString().split('\0').filter(Boolean);
    if (flags.some(entry => !this.excluded(work, entry.slice(2)) && (entry[0] === 'S' || /[a-z]/.test(entry[0])))) throw new ConflictException('제품 소스의 assume-unchanged/skip-worktree 상태를 외부 Git에서 정리한 뒤 다시 검증해 주세요.');
    const tracked = (await this.run(root, ['ls-files', '--cached', '-z'])).toString().split('\0').filter(Boolean);
    const others = (await this.run(root, ['ls-files', '--others', '--exclude-standard', '-z'])).toString().split('\0').filter(path => path && !this.excluded(work, path));
    const paths = [...new Set([...tracked, ...others])];
    for (let offset = 0; offset < paths.length;) {
      const batch: string[] = []; let bytes = 0;
      while (offset < paths.length && batch.length < 100 && bytes + paths[offset].length < 16000) { bytes += paths[offset].length + 3; batch.push(paths[offset++]); }
      if (!batch.length) throw new ConflictException('Git 속성 검사 경로 길이 한도를 초과했습니다.');
      const attrs = (await this.run(root, ['check-attr', '-z', 'filter', 'working-tree-encoding', 'ident', '--', ...batch])).toString().split('\0');
      for (let n = 0; n + 2 < attrs.length; n += 3) if (!['unspecified', 'unset'].includes(attrs[n + 2])) throw new ConflictException('clean 필터·인코딩·ident 변환은 지원하지 않습니다. 검증한 바이트와 커밋 일치를 확인할 수 없습니다.');
    }
  }
  private request(id: string, integrationId?: string) {
    const row = this.store.integrationRequests().find(row => row.workId === id && (integrationId ? row.id === integrationId : row.status === 'queued'));
    if (!row || row.status !== 'queued') throw new ConflictException('대기 중인 소유 통합 요청을 먼저 확인해 주세요.');
    return row;
  }
  private parse(body: any): Input {
    const keys = ['integrationId', 'requestKey', 'confirmed', 'previewVersion', 'paths', 'message'];
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !keys.includes(key)) || body.confirmed !== true || typeof body.integrationId !== 'string' || typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(body.requestKey) || typeof body.previewVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.previewVersion) || !Array.isArray(body.paths) || body.paths.length > 10000 || body.paths.some((p: unknown) => typeof p !== 'string' || !p || p.length > 4096 || /[\0\\]/.test(p) || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) || new Set(body.paths).size !== body.paths.length || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 10000 || body.message.includes('\0')) throw new BadRequestException('미리보기 버전·전체 파일 선택·요청 키·커밋 메시지를 확인해 주세요.');
    return { integrationId: body.integrationId, requestKey: body.requestKey, confirmed: true, previewVersion: body.previewVersion, paths: [...body.paths].sort(), message: body.message };
  }
  private context(work: Work, request: IntegrationRequest) {
    return hash([work, this.works.planVersion(work), this.works.execution.snapshot(work), this.works.execution.commands(work), this.store.records(work.id, 'verification'), this.store.records(work.id, 'browser-verification'), this.store.records(work.id, 'question'), request.fingerprint]);
  }
  private async inspect(work: Work, request: IntegrationRequest) {
    const root = this.works.execution.executionPath(work);
    if (root !== request.workExecutionPath || work.workspace?.workspaceId !== request.workspaceId || work.reviewedVersion !== request.reviewedVersion || work.workspace?.preparationPolicyDigest !== this.store.get(work.id)?.workspace?.preparationPolicyDigest) throw new ConflictException('업무 공간 또는 검토 기준이 변경되었습니다.');
    const status = await new ProjectGit({ dataDir: process.env.DATA_DIR, sourcePolicy: workspaceSourcePolicy(this.store), checkRecovery: () => {} }).status(root);
    const raw = (await this.run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).toString('utf8'), index = (await this.run(root, ['ls-files', '--stage', '-z'])).toString('utf8');
    const target = await this.text(root, ['rev-parse', '--verify', `refs/heads/${request.targetBranch}^{commit}`]);
    if (!status.available || status.blocked || status.progress || status.head !== (request.resultCommit ?? request.workHead) || target !== request.targetHead || status.branch !== work.workspace?.branch || realpathSync(await this.text(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== realpathSync(request.commonDir)) throw new ConflictException('업무·대상 HEAD 또는 Git 상태가 변경되었습니다.');
    const fields = raw.split('\0'), entries: Entry[] = [];
    for (let n = 0; n < fields.length; n++) {
      const line = fields[n]; if (!line) continue;
      const xy = line.slice(0, 2), path = line.slice(3), originalPath = /[RC]/.test(xy) ? fields[++n] : undefined;
      if (xy.includes('U') || ['AA', 'DD'].includes(xy)) throw new ConflictException('미해결 충돌을 먼저 정리해 주세요.');
      const selectable = !this.excluded(work, path) && (!originalPath || !this.excluded(work, originalPath));
      entries.push({ path, ...(originalPath ? { originalPath } : {}), index: xy[0], worktree: xy[1], untracked: xy === '??', selectable, partial: xy !== '??' && xy[0] !== ' ' && xy[1] !== ' ' });
    }
    if (entries.length > 10000) throw new ConflictException('변경 파일 한도 10000개를 초과했습니다.');
    const source = this.works.execution.snapshot(work), mentioned = new Set(entries.flatMap(entry => [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])]));
    const headFiles = new Map((await this.run(root, ['ls-tree', '-r', '-z', status.head!])).toString().split('\0').filter(Boolean).map(entry => { const at = entry.indexOf('\t'); return [entry.slice(at + 1), entry.slice(0, at).split(' ')[0]] as [string, string]; }));
    const flags = (await this.run(root, ['ls-files', '-v', '-z'])).toString().split('\0').filter(Boolean);
    if (flags.some(entry => !this.excluded(work, entry.slice(2)) && (entry[0] === 'S' || /[a-z]/.test(entry[0])))) throw new ConflictException('제품 소스의 assume-unchanged/skip-worktree 상태를 외부 Git에서 정리한 뒤 다시 검증해 주세요.');
    if (Object.entries(source).some(([path, file]) => !mentioned.has(path) && (!headFiles.has(path) || headFiles.get(path) !== file.mode)) || [...headFiles.keys()].some(path => !this.excluded(work, path) && !source[path] && !mentioned.has(path))) throw new ConflictException('Git 상태에 표시되지 않는 검증 소스가 있습니다. ignore·삭제·mode 상태를 직접 정리하고 다시 검증해 주세요.');
    const context = this.context(work, request), conversion = (await runGit(root, ['config', '--null', '--get-regexp', '^(core[.](autocrlf|eol|safecrlf|attributesfile)|filter[.])'], {}, true)).toString();
    return { root, entries, index, raw, head: status.head!, context, version: hash([request.id, status.token, raw, index, context, target, conversion]) };
  }
  async preview(id: string) {
    const request = this.request(id); await this.assertConversions(this.works.get(id)); const ready = await this.works.integrationReadiness(id, request.reviewedVersion);
    const view = await this.inspect(ready.work, request);
    if (this.context(this.works.get(id), request) !== view.context) throw new ConflictException('미리보기 중 검증 소스가 변경되었습니다.');
    return { integrationId: request.id, version: view.version, head: view.head, entries: view.entries, selectionMode: 'whole-file', partialStageGuidance: '부분 stage 파일은 앱 소스/Git의 파일 전체 스테이징으로 정리한 뒤 다시 조회하세요.' };
  }
  private save(id: string, workId: string, row: any) { this.store.record(id, workId, 'integration-result-commit', row); return row; }
  private attach(request: IntegrationRequest, commit: string, tree: string) {
    const current = this.store.integrationRequests().find(row => row.id === request.id)!;
    if (current.resultCommit && current.resultCommit !== commit) throw new ConflictException('이미 저장한 결과 커밋과 다릅니다.');
    this.store.record(request.id, request.workId, 'integration-request', { ...current, resultCommit: commit, resultTree: tree });
  }
  private async assertIdentity(work: Work, request: IntegrationRequest, head: string) {
    if (this.works.execution.executionPath(this.works.get(work.id)) !== request.workExecutionPath || await this.text(request.workExecutionPath, ['symbolic-ref', 'HEAD']) !== `refs/heads/${work.workspace!.branch}` || await this.text(request.workExecutionPath, ['rev-parse', 'HEAD']) !== head || await this.text(request.workExecutionPath, ['rev-parse', `refs/heads/${request.targetBranch}`]) !== request.targetHead || realpathSync(await this.text(request.workExecutionPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== realpathSync(request.commonDir)) throw new ConflictException('실행 공간·업무 브랜치·대상 기준이 변경되었습니다.');
  }
  private async replay(workId: string, row: any) {
    if (!['running', 'uncertain', 'committed', 'noop'].includes(row.status)) return row;
    try { if (this.works.execution.executionPath(this.works.get(workId)) !== row.root) throw new Error('path'); }
    catch { return { ...row, status: 'uncertain', error: '소유 업무 공간의 identity와 실행 경로를 다시 확인해 주세요.' }; }
    if (row.status !== 'committed' && row.processId && !row.processTerminated) {
      try { process.kill(row.processId, 0); return { ...row, status: 'uncertain', error: '기존 Git 프로세스의 종료 확인이 필요합니다.' }; } catch (error: any) { if (error.code !== 'ESRCH') return { ...row, status: 'uncertain' }; }
    }
    const head = await this.text(row.root, ['rev-parse', 'HEAD']), tree = await this.text(row.root, ['rev-parse', 'HEAD^{tree}']);
    const request = this.store.integrationRequests().find(x => x.id === row.integrationId)!;
    if (row.status === 'noop' && head === row.startHead && tree === row.tree && await this.text(row.root, ['symbolic-ref', 'HEAD']) === row.ref) return row;
    if (row.commitObject && head === row.commitObject && row.expectedTree && tree === row.expectedTree && head !== row.startHead && await this.text(row.root, ['symbolic-ref', 'HEAD']) === row.ref && realpathSync(await this.text(row.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) === realpathSync(request.commonDir) && await this.text(row.root, ['show', '-s', '--format=%P', head]) === row.startHead && await this.text(row.root, ['show', '-s', '--format=%B', head]) === row.message.trim()) {
      row = { ...row, status: 'committed', commit: head, tree }; const request = this.store.integrationRequests().find(x => x.id === row.integrationId)!;
      this.attach(request, head, tree); this.store.record(row.intentId, workId, 'workspace-git-intent', { ...row.intent, status: 'passed' }); return this.save(row.id, workId, row);
    }
    if (['committed', 'noop'].includes(row.status)) return { ...row, status: 'uncertain', error: '저장한 결과 커밋과 실제 HEAD·부모·tree가 다릅니다.' };
    // A concurrent observer must never overwrite a live writer's newer process/tree evidence.
    return { ...row, status: 'uncertain', error: '실제 커밋 결과를 확인할 수 없습니다. 자동 재실행하지 않습니다.' };
  }
  async commit(id: string, body: unknown) {
    const input = this.parse(body), fingerprint = hash(input), recordId = `result-commit:${hash([id, input.requestKey])}`;
    const existing = this.store.records(id, 'integration-result-commit').find(row => row.id === recordId);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new ConflictException('같은 요청 키에 다른 내용을 사용할 수 없습니다.'); return this.replay(id, existing); }
    this.lifecycle.assertUnlocked(); const settle = this.lifecycle.beginRequest('integration-result-commit', id);
    let release: (() => void) | undefined, row: any, reserved = false, directory: string | undefined, owned: { dev: number; ino: number } | undefined, ownedFile: { dev: number; ino: number } | undefined;
    try {
      const request = this.request(id, input.integrationId); await this.assertConversions(this.works.get(id)); const ready = await this.works.integrationReadiness(id, request.reviewedVersion), work = ready.work;
      release = projectCoordinator(this.store).acquireOperation({ kind: 'index', root: request.workExecutionPath, commonDir: request.commonDir });
      const view = await this.inspect(work, request);
      if (view.version !== input.previewVersion || ready.sourceRevision !== request.sourceRevision || request.resultCommit) throw new ConflictException('미리보기 또는 검증 기준이 변경되었습니다. 다시 확인해 주세요.');
      const selected = new Set(input.paths);
      if (view.entries.some(e => e.selectable && !selected.has(e.path))) throw new ConflictException('검증한 소스 변경을 모두 선택해야 합니다.');
      for (const entry of view.entries) {
        if (entry.index !== ' ' && !entry.untracked && (!entry.selectable || !selected.has(entry.path))) throw new ConflictException('선택 밖 staged 또는 비공개 파일이 있습니다.');
        if (selected.has(entry.path) && entry.partial) throw new ConflictException('부분 stage 파일은 앱 소스/Git의 파일 전체 스테이징으로 정리한 뒤 다시 조회하세요.');
      }
      if (input.paths.some(p => !view.entries.some(e => e.path === p && e.selectable))) throw new ConflictException('선택 범위가 현재 변경 목록과 다릅니다.');
      const paths = [...new Set(view.entries.filter(e => selected.has(e.path)).flatMap(e => [e.path, ...(e.originalPath ? [e.originalPath] : [])]))].sort();
      const expected = new Map<string, string | null>(), sourceFiles = this.works.execution.snapshot(work);
      const algorithm = await this.text(view.root, ['rev-parse', '--show-object-format']), autocrlf = (await runGit(view.root, ['config', '--get', 'core.autocrlf'], {}, true)).toString().trim();
      const attributes = new Map<string, Record<string, string>>();
      for (let offset = 0; offset < paths.length;) {
        const batch: string[] = []; let length = 0;
        while (offset < paths.length && batch.length < 100 && length + paths[offset].length < 16000) { length += paths[offset].length + 3; batch.push(paths[offset++]); }
        const attrs = (await this.run(view.root, ['check-attr', '-z', 'filter', 'working-tree-encoding', 'ident', 'text', 'eol', '--', ...batch])).toString().split('\0');
        for (let i = 0; i + 2 < attrs.length; i += 3) { const values = attributes.get(attrs[i]) ?? {}; values[attrs[i + 1]] = attrs[i + 2]; attributes.set(attrs[i], values); }
      }
      for (const path of paths) {
        if (managedPrivatePath(path)) throw new ConflictException('비공개 파일은 커밋할 수 없습니다.');
        let content: Buffer; try { content = ownedRead(view.root, path); } catch (error: any) { if (error.code === 'ENOENT') { expected.set(path, null); continue; } throw error; }
        const values = attributes.get(path)!;
        if (['filter', 'working-tree-encoding', 'ident'].some(name => !['unspecified', 'unset'].includes(values[name]))) throw new ConflictException('clean 필터·인코딩·ident 변환은 지원하지 않습니다. 검증한 바이트와 커밋 일치를 확인할 수 없습니다.');
        const text = values.text !== 'unset' && (['set', 'auto'].includes(values.text) || ['lf', 'crlf'].includes(values.eol) || ['true', 'input'].includes(autocrlf));
        if (text && !content.includes(0)) content = Buffer.from(content.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
        expected.set(path, createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex'));
      }
      if (this.context(this.works.get(id), request) !== view.context || (await this.inspect(work, request)).version !== view.version) throw new ConflictException('커밋 준비 중 소스·index 또는 검증이 변경되었습니다.');
      const parent = resolve(process.env.DATA_DIR || '../.data'); inspectWorkspacePath(parent, []); mkdirSync(parent, { recursive: true });
      directory = join(parent, `result-commit-${randomUUID()}`); mkdirSync(directory); owned = lstatSync(directory);
      if (realpathSync(directory) !== resolve(directory)) throw new ConflictException('호스트 임시 경로 경계를 확인할 수 없습니다.');
      const pathspec = join(directory, 'paths.nul'), fd = openSync(pathspec, 'wx'); try { writeFileSync(fd, Buffer.from(paths.join('\0') + '\0')); } finally { closeSync(fd); }
      const fileStat = lstatSync(pathspec); if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) throw new ConflictException('선택 경로 파일 소유가 변경되었습니다.');
      ownedFile = fileStat;
      const intent = { scope: 'index', root: view.root, commonDir: request.commonDir, refs: [`refs/heads/${work.workspace!.branch}`], affectedRoots: [view.root], status: 'running', processId: undefined as number | undefined };
      const intentId = `${recordId}:git`;
      row = { id: recordId, intentId, workId: id, integrationId: request.id, fingerprint, root: view.root, ref: `refs/heads/${work.workspace!.branch}`, startHead: view.head, sourceRevision: ready.sourceRevision, verificationRefs: ready.workVerificationRefs, message: input.message, paths, status: 'running', intent, createdAt: new Date().toISOString() };
      this.store.transaction(() => { if (this.store.records(id, 'integration-result-commit').some(x => x.id === recordId)) throw new ConflictException('같은 요청이 진행 중입니다. 같은 키로 다시 조회해 주세요.'); projectCoordinator(this.store).assertRecovery({ kind: 'index', root: view.root, commonDir: request.commonDir }); this.save(recordId, id, row); this.store.record(intentId, id, 'workspace-git-intent', intent); });
      reserved = true;
      const mutate = async (args: string[]) => {
        const currentDir = lstatSync(directory!), currentFile = lstatSync(pathspec);
        if (currentDir.dev !== owned!.dev || currentDir.ino !== owned!.ino || currentDir.isSymbolicLink() || currentFile.dev !== fileStat.dev || currentFile.ino !== fileStat.ino || currentFile.isSymbolicLink() || currentFile.nlink !== 1 || !readFileSync(pathspec).equals(Buffer.from(paths.join('\0') + '\0'))) throw new ConflictException('호스트 선택 파일의 소유 또는 내용이 변경되었습니다.');
        row.processTerminated = false;
        try {
          const output = await runGit(view.root, ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${directory}`, '-c', 'commit.gpgSign=false', ...args], { onSpawn: pid => { row.processId = intent.processId = pid; this.store.transaction(() => { this.save(recordId, id, row); this.store.record(intentId, id, 'workspace-git-intent', intent); }); } });
          row.processTerminated = true; return output;
        } catch (error) { row.processTerminated = error instanceof GitError && !error.terminationUnconfirmed; throw error; }
      };
      if (!paths.length) {
        await this.assertIdentity(work, request, view.head);
        row.tree = await this.text(view.root, ['rev-parse', `${view.head}^{tree}`]);
        await this.assertIdentity(work, request, view.head);
        if (this.context(this.works.get(id), request) !== view.context) throw new ConflictException('빈 선택 확인 중 검증 소스가 변경되었습니다.');
        row.status = 'noop'; row.commit = view.head;
      } else {
        await this.assertIdentity(work, request, view.head);
        await mutate(['add', '-A', `--pathspec-from-file=${pathspec}`, '--pathspec-file-nul']); row.staged = true;
        const changed = (await this.run(view.root, ['diff', '--cached', '--no-renames', '--name-only', '-z', 'HEAD', '--'])).toString().split('\0').filter(Boolean);
        if (changed.some(p => !expected.has(p))) throw new ConflictException('선택 밖 index 변경이 감지되었습니다.');
        const indexEntries = new Map((await this.run(view.root, ['ls-files', '--stage', '-z'])).toString().split('\0').filter(Boolean).map(entry => { const at = entry.indexOf('\t'); return [entry.slice(at + 1), entry.slice(0, at)] as [string, string]; }));
        for (const [path, expectedHash] of expected) {
          const meta = indexEntries.get(path) ?? '';
          if (expectedHash === null ? !!meta : !/^100(?:644|755) [a-f0-9]+ 0$/.test(meta) || meta.split(' ')[1] !== expectedHash) throw new ConflictException('검증한 파일 전체 내용과 stage 결과가 다릅니다.');
        }
        if (this.context(this.works.get(id), request) !== view.context || await this.text(view.root, ['rev-parse', 'HEAD']) !== view.head) throw new ConflictException('stage 중 소스·검증 또는 HEAD가 변경되었습니다.');
        row.expectedTree = await this.text(view.root, ['write-tree']);
        const treeEntries = async (tree: string) => new Map((await this.run(view.root, ['ls-tree', '-r', '-z', tree])).toString().split('\0').filter(Boolean).map(entry => { const at = entry.indexOf('\t'), [mode, type, oid] = entry.slice(0, at).split(' '); return [entry.slice(at + 1), `${mode} ${type} ${oid}`] as [string, string]; }));
        const wanted = await treeEntries(view.head), actual = await treeEntries(row.expectedTree);
        for (const [path, oid] of expected) { if (oid === null) wanted.delete(path); else wanted.set(path, `${sourceFiles[path]?.mode ?? '100644'} blob ${oid}`); }
        if (hash([...wanted].sort()) !== hash([...actual].sort())) throw new ConflictException('선택한 경로·내용·mode와 실제 커밋 tree가 다릅니다.');
        this.save(recordId, id, row);
        await this.assertIdentity(work, request, view.head);
        if (this.context(this.works.get(id), request) !== view.context) throw new ConflictException('커밋 직전 검증 소스가 변경되었습니다.');
        // Commit the verified immutable tree, never reread a concurrently editable index.
        row.commitObject = (await mutate(['commit-tree', row.expectedTree, '-p', view.head, '-m', input.message])).toString().trim(); this.save(recordId, id, row);
        await this.assertIdentity(work, request, view.head);
        if (this.context(this.works.get(id), request) !== view.context) throw new ConflictException('ref 반영 직전 소스·계획·검증 상태가 변경되었습니다.');
        row.commitStarted = true; this.save(recordId, id, row); await mutate(['update-ref', '--no-deref', row.ref, row.commitObject, view.head]);
        row.refUpdateCompleted = true; this.save(recordId, id, row);
        const head = await this.text(view.root, ['rev-parse', 'HEAD']);
        await this.assertIdentity(work, request, head);
        if (head !== row.commitObject || await this.text(view.root, ['rev-parse', 'HEAD^{tree}']) !== row.expectedTree || await this.text(view.root, ['show', '-s', '--format=%P', head]) !== view.head) throw new ConflictException('실제 결과 커밋의 OID·부모·tree가 예상과 다릅니다.');
        row.status = 'committed'; row.commit = head; row.tree = row.expectedTree;
      }
      this.store.transaction(() => { this.attach(request, row.commit, row.tree); this.save(recordId, id, row); this.store.record(intentId, id, 'workspace-git-intent', { ...intent, status: 'passed' }); }); return row;
    } catch (error: any) {
      if (!reserved) throw error;
      row.status = row.refUpdateCompleted ? 'uncertain' : error instanceof GitError && !error.uncertain ? 'failed' : row.commitStarted || error instanceof GitError && error.uncertain ? 'uncertain' : 'failed'; row.error = error instanceof Error ? error.message : '커밋 결과 확인이 필요합니다.';
      this.store.transaction(() => { this.save(recordId, id, row); this.store.record(row.intentId, id, 'workspace-git-intent', { ...row.intent, status: row.status, terminationUnconfirmed: error instanceof GitError && error.terminationUnconfirmed }); }); return row;
    } finally {
      try {
        if (directory && owned && row?.processTerminated !== false) {
          try { const current = lstatSync(directory); if (current.dev !== owned.dev || current.ino !== owned.ino || current.isSymbolicLink() || realpathSync(directory) !== resolve(directory)) throw new Error('ownership'); const path = join(directory, 'paths.nul'), stat = lstatSync(path); if (!ownedFile || stat.dev !== ownedFile.dev || stat.ino !== ownedFile.ino || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('ownership'); unlinkSync(path); rmdirSync(directory); }
          catch { if (reserved && row) { row.cleanupWarning = '호스트 임시 경로의 정리를 확인하지 못해 보존했습니다.'; try { this.save(row.id, id, row); } catch { /* Preserve durable Git uncertainty. */ } } }
        }
      } finally {
        if (row?.processTerminated === false && row.processId) {
          const finish = release, pid = row.processId;
          const timer = setInterval(() => { try { process.kill(pid, 0); } catch (error: any) { if (error.code === 'ESRCH') { clearInterval(timer); try { finish?.(); } finally { settle(); } } } }, 1000); timer.unref();
        } else { try { release?.(); } finally { settle(); } }
      }
    }
  }
}
