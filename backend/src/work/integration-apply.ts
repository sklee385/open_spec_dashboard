import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WorkStore, type IntegrationRequest } from './store';
import { IntegrationApplyPreflight } from './integration-apply-preflight';
import { MutationAdmission } from './mutation-admission';
import { DesktopLifecycle } from '../desktop/lifecycle';
import { desktopHealth } from '../desktop/health';
import { projectCoordinator } from '../projects/coordinator';
import { GitError, runGit } from '../projects/git-runner';
import { collectFiles } from './file-results';
import { inspectWorkspacePath } from './workspace-paths';
import { workspaceResourcePath } from './workspace-file-policy';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const host = randomUUID();
type Input = { requestKey: string; confirmed: true; expectedVersion: string };
type Proof = Awaited<ReturnType<IntegrationApplyPreflight['capture']>>;

/** One explicit local fast-forward. Replay observes the journal and never starts Git again. */
@Injectable()
export class IntegrationApply {
  private active = new Map<string, { fingerprint: string; promise: Promise<any> }>();
  constructor(@Inject(WorkStore) private store: WorkStore, @Inject(IntegrationApplyPreflight) private preflight: IntegrationApplyPreflight,
    @Inject(DesktopLifecycle) private lifecycle: DesktopLifecycle) {
    desktopHealth(store).register('integration-apply', work => {
      const rows = store.records(work.id, 'integration-apply');
      if (rows.some(row => row.status === 'running' || row.status === 'uncertain' && row.processTerminated !== true)) return 'unknown';
      return undefined;
    });
  }
  private parse(body: any): Input {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['requestKey', 'confirmed', 'expectedVersion'].includes(key)) || typeof body.requestKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(body.requestKey) || body.confirmed !== true || typeof body.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedVersion)) throw new BadRequestException('적용 요청 키·명시 확인·사전검사 버전을 확인해 주세요');
    return { requestKey: body.requestKey, confirmed: true, expectedVersion: body.expectedVersion };
  }
  private replay(workId: string, candidateId: string, input: Input) {
    const row = this.store.records(workId, 'integration-apply').find(row => row.candidateId === candidateId && row.requestKey === input.requestKey);
    if (row && row.fingerprint !== hash([workId, candidateId, input])) throw new ConflictException('같은 적용 키에 다른 내용을 사용할 수 없습니다');
    return row;
  }
  private save(row: any) { this.store.record(row.id, row.workId, 'integration-apply', row); }
  private read(root: string, args: string[]) { return runGit(root, ['-c', 'core.fsmonitor=false', ...args]).then(value => value.toString()); }
  private async sides(request: IntegrationRequest) {
    const work = this.store.get(request.workId)!;
    return hash(await Promise.all([request.workExecutionPath, request.executionPath].map(async root => {
      inspectWorkspacePath(root, []);
      const [head, branch, index] = await Promise.all([this.read(root, ['rev-parse', 'HEAD']), this.read(root, ['symbolic-ref', 'HEAD']), this.read(root, ['ls-files', '--stage', '-z'])]);
      const files = collectFiles(root, path => workspaceResourcePath(work, path), true);
      return [root, realpathSync(root), head, branch, index, files, Object.keys(files).map(path => [path, lstatSync(join(root, path)).mode & 0o777])];
    })));
  }
  private hooks() {
    const data = resolve(process.env.DATA_DIR || '../.data'); inspectWorkspacePath(data, []); mkdirSync(data, { recursive: true });
    const path = mkdtempSync(join(data, 'integration-hooks-')), before = lstatSync(path);
    const check = () => {
      inspectWorkspacePath(path, []); const current = lstatSync(path);
      if (!current.isDirectory() || current.dev !== before.dev || current.ino !== before.ino || realpathSync(path) !== path || readdirSync(path).length) throw new ConflictException('호스트 소유의 빈 Git hook 경계를 확인할 수 없습니다');
    };
    check(); return { path, check, remove: () => { check(); rmdirSync(path); } };
  }
  async apply(workId: string, candidateId: string, body: unknown) {
    const input = this.parse(body), replay = this.replay(workId, candidateId, input); if (replay) return replay;
    const id = `integration-apply:${hash([workId, candidateId, input.requestKey])}`, fingerprint = hash([workId, candidateId, input]);
    const active = this.active.get(id);
    if (active) { if (active.fingerprint !== fingerprint) throw new ConflictException('같은 적용 키에 다른 내용을 사용할 수 없습니다'); return active.promise; }
    const promise = new MutationAdmission(this.store, workId, 'integration-apply', input.requestKey, fingerprint, () => !!this.replay(workId, candidateId, input)).run(admission => this.execute(workId, candidateId, input, id, fingerprint, admission));
    this.active.set(id, { fingerprint, promise });
    try { return await promise; } catch (error) { const saved = this.replay(workId, candidateId, input); if (saved) return saved; throw error; }
    finally { this.active.delete(id); }
  }
  private async execute(workId: string, candidateId: string, input: Input, id: string, fingerprint: string, admission: MutationAdmission) {
    let release: (() => void) | undefined, settle: (() => void) | undefined, hooks: ReturnType<IntegrationApply['hooks']> | undefined, row: any, proof: Proof | undefined, sideVersion: string | undefined;
    const now = () => new Date().toISOString();
    try {
      const replay = this.replay(workId, candidateId, input); if (replay) return replay;
      if (process.platform !== 'win32') throw new ConflictException('원본 Git 반영의 native HEAD 보호는 현재 Windows에서만 지원합니다');
      this.lifecycle.assertUnlocked(); settle = this.lifecycle.beginRequest('integration-apply', workId);
      const previous = this.store.integrationRequests().find(request => request.workId === workId && request.candidateId === candidateId);
      if (previous && ['applied', 'applying', 'uncertain', 'failed'].includes(previous.status)) throw new ConflictException('기존 적용 또는 미확인 결과를 먼저 확인해 주세요');
      proof = await this.preflight.capture(workId, candidateId);
      if (proof.expectedVersion !== input.expectedVersion) throw new ConflictException('사전검사 버전이 변경되었습니다');
      release = projectCoordinator(this.store).acquireOperation(proof.plan);
      const sourceAttributes = await this.preflight.captureSourceAttributes(proof.request);
      sideVersion = await this.sides(proof.request); hooks = this.hooks();
      const fixed = proof, intentId = `${id}:git`, intent: any = { scope: fixed.plan.kind, root: fixed.plan.root, commonDir: fixed.plan.commonDir, refs: fixed.plan.refs, affectedRoots: fixed.plan.spaces, stage: 'integration-apply', status: 'running', owner: host, ownerProcessId: process.pid, runGeneration: randomUUID(), processTerminated: false };
      this.store.transaction(() => {
        if (this.replay(workId, candidateId, input)) throw new ConflictException('이미 저장된 적용 요청입니다');
        projectCoordinator(this.store).assertRecovery(fixed.plan); fixed.assertUnchanged(); sourceAttributes.assertUnchanged(); hooks!.check();
        row = { id, workId, candidateId, requestKey: input.requestKey, fingerprint, expectedVersion: input.expectedVersion, sourceAttributeVersion: sourceAttributes.version, targetBranch: fixed.request.targetBranch, targetHead: fixed.request.targetHead, candidateCommit: fixed.request.candidateCommit, candidateEpoch: fixed.request.candidateMutationVersion ?? null, verificationRefs: fixed.verificationRefs, requestId: fixed.request.id, intentId, sideVersion, owner: host, ownerProcessId: process.pid, runGeneration: intent.runGeneration, status: 'running', applied: false, processTerminated: false, createdAt: now() };
        admission.admit(); this.save(row); this.store.record(intentId, workId, 'workspace-git-intent', intent);
      });
      try {
        await runGit(fixed.request.projectPath, ['--git-dir='+fixed.sourceGitDir, '--work-tree='+fixed.request.projectPath, '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${hooks.path}`, '-c', 'merge.autostash=false', '-c', 'rebase.autostash=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'merge.verifySignatures=false', 'merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '--no-edit', '--no-stat', '--no-log', fixed.request.candidateCommit!], {
          onSpawn: pid => { row.processId = intent.processId = pid; row.processKind = 'waiting-git-worker'; this.store.transaction(() => { this.save(row); this.store.record(intentId, workId, 'workspace-git-intent', intent); }); },
          headPin: { file: join(fixed.sourceGitDir, 'HEAD'), ref: `refs/heads/${fixed.request.targetBranch}`, beforeDispatch: () => {
            // Native HEAD pin and Job assignment already exist. Capture again would
            // conflict with our scoped lock; this is the final synchronous proof fence.
            this.store.transaction(() => {
              fixed.assertUnchanged(); sourceAttributes.assertUnchanged(); hooks!.check();
              row.commandStarted = true; this.save(row);
              this.store.record(fixed.request.id, workId, 'integration-request', { ...fixed.request, status: 'applying', applyAttemptId: id, updatedAt: now() });
            });
          } },
        });
        row.processTerminated = true;
      } catch (error: any) {
        row.error = error.message; row.processTerminated = error instanceof GitError && !error.terminationUnconfirmed;
      }
      await this.observe(row, fixed, sideVersion);
      return this.publish(row, fixed.request, intent);
    } catch (error: any) {
      if (!row || !this.store.records(workId, 'integration-apply').some(saved => saved.id === id)) throw error;
      // A publication failure can have committed. Re-read the durable result first.
      const saved = this.replay(workId, candidateId, input);
      if (saved && saved.status === 'applied') return saved;
      row.error = error.message; row.status = 'uncertain'; row.applied = false;
      if (!row.commandStarted) row.processTerminated = true;
      if (proof && !row.observedHead) try { row.observedHead = (await this.read(proof.request.projectPath, ['rev-parse', 'HEAD'])).trim(); } catch {}
      try {
        this.store.transaction(() => {
          this.save(row); const intent = this.store.records(workId, 'workspace-git-intent').find(item => item.id === row.intentId);
          if (intent) this.store.record(row.intentId, workId, 'workspace-git-intent', { ...intent, status: 'uncertain', processTerminated: row.processTerminated, terminationUnconfirmed: row.processTerminated !== true });
          if (proof) this.store.record(proof.request.id, workId, 'integration-request', { ...this.store.integrationRequests().find(item => item.id === proof!.request.id)!, status: 'uncertain', error: row.error, updatedAt: now() });
        });
      } catch { /* The original admitted intent remains the fence if this acknowledgement fails too. */ }
      return this.replay(workId, candidateId, input) ?? row;
    } finally {
      if (hooks && row?.processTerminated !== false) try { hooks.remove(); } catch { /* Preserve a changed host directory; never delete recursively. */ }
      try { release?.(); } finally { settle?.(); }
    }
  }
  private async observe(row: any, proof: Proof, sides: string) {
    row.status = 'uncertain'; row.applied = false; row.endedAt = new Date().toISOString();
    try {
      row.observedHead = (await this.read(proof.request.projectPath, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      if (row.processTerminated !== true || await this.sides(proof.request) !== sides) return;
      if (row.observedHead === proof.request.candidateCommit) {
        const observed = await this.preflight.inspectOriginal(proof.request, proof.request.candidateCommit!);
        row.status = 'applied'; row.applied = true; row.appliedCommit = observed.head; row.originalVersion = observed.version;
      } else if (row.observedHead === proof.request.targetHead) {
        await this.preflight.inspectOriginal(proof.request, proof.request.targetHead); row.status = 'failed';
      }
    } catch (error: any) { row.observationError = error.message; }
  }
  private publish(row: any, request: IntegrationRequest, intent: any) {
    this.store.transaction(() => {
      const current = this.store.integrationRequests().find(item => item.id === request.id)!;
      const owned = current?.status === 'applying' && (current as any).applyAttemptId === row.id;
      const notDispatched = row.commandStarted !== true && current && hash({ ...current, status: request.status, updatedAt: request.updatedAt, verificationRefs: request.verificationRefs }) === hash(request);
      if ((!owned && !notDispatched) || current.candidateCommit !== request.candidateCommit || current.candidateMutationVersion !== request.candidateMutationVersion) throw new ConflictException('적용 결과를 저장하는 동안 후보 소유가 변경되었습니다');
      this.save(row); this.store.record(row.intentId, row.workId, 'workspace-git-intent', { ...intent, processId: row.processId, status: row.status === 'applied' ? 'passed' : row.status, processTerminated: row.processTerminated, terminationUnconfirmed: row.processTerminated !== true });
      this.store.record(request.id, row.workId, 'integration-request', { ...current, status: row.status, ...(row.appliedCommit ? { appliedCommit: row.appliedCommit } : {}), ...(row.error ? { error: row.error } : {}), updatedAt: new Date().toISOString() });
    });
    return row;
  }
}
