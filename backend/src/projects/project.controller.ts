import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, HttpException, Inject, OnModuleDestroy, Optional, Param, Post, Put, Query } from '@nestjs/common';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LegacyService } from '../legacy/legacy.service';
import { WorkStore } from '../work/store';
import { DesktopLifecycle } from '../desktop/lifecycle';
import { ProjectResolver } from './resolver';
import { ProjectFiles } from './files';
import { ProjectGit, type GitOperation, type OperationBody } from './git';
import { assertOperationKind } from './git-operations';
import { projectCoordinator } from './coordinator';
import { workspaceSourcePolicy } from '../work/workspace-file-policy';
import { fileOperation, gitOperation } from './operation-scope';
import { ProjectWorkspaceMetadata } from './workspace-metadata';
import { CandidateGitReadBlocked, IntegrationEditing } from '../work/integration-editing';

function canonical(root: string) { try { root = realpathSync(root); } catch { root = resolve(root); } return process.platform === 'win32' ? root.toLowerCase() : root; }

@Controller('projects/:sourceId')
export class ProjectController implements OnModuleDestroy {
  private readonly files: ProjectFiles;
  private readonly git: ProjectGit;
  private readonly coordinator;
  private readonly starting = new Map<string, { fingerprint: string; promise: Promise<GitOperation> }>();
  constructor(@Inject(ProjectResolver) private readonly resolver: ProjectResolver,
    @Inject(WorkStore) private readonly store: WorkStore,
    @Inject(LegacyService) private readonly legacy: LegacyService,
    @Inject(DesktopLifecycle) private readonly lifecycle: DesktopLifecycle,
    @Optional() @Inject(IntegrationEditing) private readonly candidateEditing?: IntegrationEditing) {
      this.coordinator = projectCoordinator(store);
      const sourcePolicy = workspaceSourcePolicy(store);
      this.files = new ProjectFiles(sourcePolicy); this.git = new ProjectGit({ dataDir: resolve(process.env.DATA_DIR || '../.data'), sourcePolicy, checkRecovery: root => this.coordinator.assertRecovery({ kind: 'workspace', root }) });
    }

  private async query<T>(run: () => T | Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error: any) {
      if (error instanceof HttpException) throw error;
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) throw new HttpException({ message: error.message }, error.status);
      throw error;
    }
  }
  private root(sourceId: string, workId?: string, candidateId?: string) { return this.resolver.resolve(sourceId, workId, candidateId).root; }
  private writableRoot(sourceId: string, workId?: string, candidateId?: string) {
    const root = this.root(sourceId, workId, candidateId);
    if (candidateId !== undefined) throw new ConflictException('후보는 현재 읽기 전용입니다. 후보 충돌 해결 절차를 사용해 주세요');
    return root;
  }
  private changed(root: string, paths?: string[]) {
    for (const work of this.store.list()) {
      if (['completed', 'archived'].includes(work.phase) || (canonical(work.projectPath) !== canonical(root) && (!work.executionPath || canonical(work.executionPath) !== canonical(root)))) continue;
      // Source edits invalidate results even when a work has an isolated execution tree.
      work.sourceMutationVersion = randomUUID();
      const prefix = `openspec/changes/${work.changeName}/`;
      if (!paths || paths.some(path => path === 'openspec' || path === `openspec/changes/${work.changeName}` || path.startsWith(prefix) || prefix.startsWith(path.replace(/\/$/, '') + '/'))) work.reviewedVersion = null;
      this.store.save(work);
      this.store.event(work.id, 'project-changed', { paths: paths || [], version: work.sourceMutationVersion });
    }
    this.legacy.updates.next();
  }
  private async mutate<T>(sourceId: string, workId: string | undefined, paths: string[], run: (root: string) => T | Promise<T>, candidateId?: string) {
    return this.query(async () => {
      const root = this.writableRoot(sourceId, workId, candidateId);
      const release = this.coordinator.acquireOperation(fileOperation(root, paths));
      try { const result = await run(root); this.changed(root, paths); return result; }
      finally { release(); }
    });
  }

  @Get('tree') tree(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Query('path') path = '', @Query('showHidden') hidden?: string, @Query('cursor') cursor?: string, @Query('candidateId') candidateId?: string) {
    return this.query(() => this.files.tree(this.root(source, workId, candidateId), path, { showHidden: hidden === 'true', cursor }));
  }
  @Get('search') search(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Query('q') q = '', @Query('showHidden') hidden?: string, @Query('cursor') cursor?: string, @Query('candidateId') candidateId?: string) {
    return this.query(() => this.files.search(this.root(source, workId, candidateId), q, { showHidden: hidden === 'true', cursor }));
  }
  @Get('file') file(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Query('path') path: string, @Query('candidateId') candidateId?: string) { return this.query(async () => {
    const root = this.root(source, workId, candidateId);
    if (candidateId !== undefined && this.candidateEditing) return this.candidateEditing.file(source, workId!, candidateId, path);
    const file = await this.files.read(root, path); return candidateId === undefined ? file : { ...file, editable: false, reason: '후보는 현재 읽기 전용입니다' };
  }); }
  @Get('entry') entry(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Query('path') path: string, @Query('candidateId') candidateId?: string) { return this.query(() => {
    const root = this.root(source, workId, candidateId); return candidateId !== undefined && this.candidateEditing ? this.candidateEditing.entry(source, workId!, candidateId, path) : this.files.entry(root, path);
  }); }
  @Put('file') save(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Body() body: any, @Query('candidateId') candidateId?: string) {
    if (candidateId !== undefined && this.candidateEditing) return this.query(() => this.candidateEditing!.saveFile(source, workId!, candidateId, body));
    return this.mutate(source, workId, [body?.path], root => this.files.save(root, body), candidateId);
  }
  @Post('entries') create(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Body() body: any, @Query('candidateId') candidateId?: string) {
    if (candidateId !== undefined && this.candidateEditing) return this.query(() => this.candidateEditing!.mutateEntry(source, workId!, candidateId, 'create', body));
    return this.mutate(source, workId, [body?.path], root => this.files.create(root, body), candidateId);
  }
  @Post('entries/move') move(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Body() body: any, @Query('candidateId') candidateId?: string) {
    if (candidateId !== undefined && this.candidateEditing) return this.query(() => this.candidateEditing!.mutateEntry(source, workId!, candidateId, 'move', body));
    return this.mutate(source, workId, [body?.path, body?.target], root => this.files.move(root, body), candidateId);
  }
  @Delete('file') remove(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Body() body: any, @Query('candidateId') candidateId?: string) {
    if (candidateId !== undefined && this.candidateEditing) return this.query(() => this.candidateEditing!.mutateEntry(source, workId!, candidateId, 'delete', body));
    return this.mutate(source, workId, [body?.path], root => this.files.remove(root, body), candidateId);
  }
  @Get('git/status') status(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Query('candidateId') candidateId?: string) { return this.query(async () => {
    const root = this.root(source, workId, candidateId); if (candidateId !== undefined && this.candidateEditing) await this.candidateEditing.assertGitRead(source, workId!, candidateId); return this.git.status(root);
  }); }
  @Get('workspace') workspace(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Query('candidateId') candidateId?: string) { return this.query(async () => {
    let blocked: string | undefined;
    if (candidateId !== undefined && this.candidateEditing) try { await this.candidateEditing.assertGitRead(source, workId!, candidateId); } catch (error) { if (error instanceof CandidateGitReadBlocked) blocked = error.message; else throw error; }
    return new ProjectWorkspaceMetadata(this.resolver, this.store, this.git).read(source, workId, candidateId, blocked);
  }); }
  @Get('git/diff') diff(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Query('path') path: string, @Query('side') side: 'staged' | 'unstaged' | 'commit', @Query('commit') commit?: string, @Query('candidateId') candidateId?: string) {
    return this.query(async () => { const root = this.root(source, workId, candidateId); if (candidateId !== undefined && this.candidateEditing) await this.candidateEditing.assertGitRead(source, workId!, candidateId); return this.git.diff(root, { path, side, commit }); });
  }
  @Get('git/branches') branches(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Query('candidateId') candidateId?: string) { return this.query(() => this.git.branches(this.root(source, workId, candidateId))); }
  @Get('git/log') log(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Query('cursor') cursor?: string, @Query('candidateId') candidateId?: string) { return this.query(() => this.git.log(this.root(source, workId, candidateId), cursor)); }
  @Get('git/commits/:hash') commit(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Param('hash') hash: string, @Query('candidateId') candidateId?: string) { return this.query(() => this.git.commit(this.root(source, workId, candidateId), hash)); }
  @Get('git/commits/:hash/file') commitFile(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Param('hash') hash: string, @Query('path') path: string, @Query('candidateId') candidateId?: string) { return this.query(() => this.git.commitFile(this.root(source, workId, candidateId), hash, path)); }
  @Get('git/operations/:id') operation(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Param('id') id: string, @Query('candidateId') candidateId?: string) { return this.query(() => this.git.get(this.root(source, workId, candidateId), id)); }
  @Post('git/operations/:id/reconcile') @HttpCode(200) reconcile(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Param('id') id: string, @Body() body: { confirmed: boolean }, @Query('candidateId') candidateId?: string) {
    return this.query(async () => {
      const root = this.writableRoot(source, workId, candidateId);
      try {
        const result = await this.git.reconcile(root, id, body);
        await this.git.assertReady(root);
        this.coordinator.unblock(root);
        return result;
      } catch (error: any) {
        if (error?.status !== 404 || body?.confirmed !== true) throw error;
        // A lost HTTP response can also mean the request never reached the server.
        // Observe under the same mutation lock; never replay a client request key.
        await this.git.assertReady(root);
        const release = this.coordinator.acquireOperation({ kind: 'workspace', root });
        try {
          const status = await this.git.status(root);
          if (status.progress) throw new ConflictException('진행 중인 Git 작업을 먼저 정리해 주세요');
          const now = new Date().toISOString();
          return { operation: { id, operationId: id, requestKey: id, kind: 'unknown', state: 'uncertain', status: 'uncertain', createdAt: now, updatedAt: now, reviewedAt: now, summary: '서버에 요청 기록이 없습니다. 실제 상태를 확인했으며 원래 요청은 재실행하지 않습니다.' }, evidence: { recordFound: false, head: status.head, upstream: status.upstream, ahead: status.ahead, behind: status.behind }, status };
        } finally { release(); }
      }
    });
  }
  @Post('git/operations') @HttpCode(202) start(@Param('sourceId') source: string, @Query('workId') workId: string | undefined, @Body() body: OperationBody, @Query('candidateId') candidateId?: string) {
    return this.query(() => {
      const root = this.writableRoot(source, workId, candidateId);
      assertOperationKind(body?.kind);
      if (!body || typeof body.requestKey !== 'string' || !body.requestKey || typeof body.token !== 'string') throw new BadRequestException('요청 키와 상태 토큰이 필요합니다');
      const key = JSON.stringify([canonical(root), body.requestKey]), fingerprint = JSON.stringify(body);
      const pending = this.starting.get(key);
      if (pending) {
        if (pending.fingerprint !== fingerprint) throw new ConflictException('같은 요청 키에 다른 작업을 사용할 수 없습니다');
        return pending.promise;
      }
      const promise = this.begin(root, body).finally(() => this.starting.delete(key));
      this.starting.set(key, { fingerprint, promise });
      return promise;
    });
  }
  private async begin(root: string, body: OperationBody) {
      const existing = await this.git.findExisting(root, body);
      if (existing) return existing;
      const request = gitOperation(root, body), resources = this.coordinator.operationPlan(request);
      const release = this.coordinator.acquireOperation(request);
      let counted = true; this.lifecycle.requests++;
      const settle = async (operation?: GitOperation) => {
        try {
          if (operation && ['pull', 'switch-branch'].includes(operation.kind)) this.changed(root);
          // The durable intent already preserves its exact affected scopes.
        } finally { if (counted) { counted = false; this.lifecycle.requests--; release(); } }
      };
      try {
        const operation = await this.git.start(root, body, { onSettled: settle, scope: { scope: request.kind, commonDir: resources[0]?.commonDir, refs: resources.filter(resource => resource.kind === 'ref').map(resource => resource.ref!), affectedRoots: [root, ...(request.spaces ?? [])].filter((value, index, all) => all.indexOf(value) === index) } });
        // Idempotent replay returns a recorded result and does not invoke the hook.
        if (operation.status !== 'running') await settle();
        return operation;
      } catch (error) { await settle(); throw error; }
  }
  async onModuleDestroy() { await (this.git as ProjectGit & { close?: () => Promise<void> }).close?.(); }
}
