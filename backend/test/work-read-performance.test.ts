import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, unlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/app';
import { WorkStore, type Work } from '../src/work/store';
import { WorkService } from '../src/work/work.service';
import { WorkController } from '../src/work/work.controller';
import { WorkspaceService } from '../src/work/workspace.service';
import { registerWorkspaceRoot } from '../src/work/workspace-root';
import { inspectWorkspacePath } from '../src/work/workspace-paths';
import { collectWorkspaceDocuments } from '../src/work/workspace-documents';

vi.setConfig({ testTimeout: 60000, hookTimeout: 30000 });
let app: any, store: WorkStore, works: WorkService, original: Work, work: Work, docs: string, identityPath: string, identity: string;
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'rd-')), source = join(root, 's'); mkdirSync(source); mkdirSync(join(root, 'c'));
  process.env.CONFIG_PATH = join(root, 'c/config.json'); process.env.DATA_DIR = join(root, 'd'); delete process.env.WORKSPACE_ROOT;
  git(source, 'init', '-b', 'main'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.test'); git(source, 'config', 'core.longpaths', 'true'); git(source, 'config', 'core.autocrlf', 'false');
  const sourceDocs = join(source, 'openspec/changes/a'); mkdirSync(join(sourceDocs, 'specs/demo'), { recursive: true });
  for (const name of ['proposal.md', 'design.md', 'tasks.md', 'specs/demo/spec.md']) writeFileSync(join(sourceDocs, name), name === 'tasks.md' ? '- [ ] task\n' : '# Plan\n');
  writeFileSync(join(source, 'code.txt'), 'base'); writeFileSync(join(source, 'code.ts'), 'export const value = 1;\n'); writeFileSync(join(source, 'package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run' } })); git(source, 'add', '--all'); git(source, 'commit', '-m', 'fixture');
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(source, 'openspec') }] }));
  app = await createApplication(); store = app.get(WorkStore); works = app.get(WorkService);
  const profileId = randomUUID(), rootPath = join(root, 'r'), registered = registerWorkspaceRoot(inspectWorkspacePath(rootPath, []), [], profileId), workspaceId = randomUUID(), projectId = 'a'.repeat(64);
  const container = join(registered.managedPath, 'projects', projectId, 'works', workspaceId), executionPath = join(container, 'project'); mkdirSync(container, { recursive: true });
  const head = git(source, 'rev-parse', 'HEAD'), branch = 'codex/work-a'; git(source, 'worktree', 'add', '-b', branch, executionPath, head);
  original = { id: 'a', sourceId: 'demo', projectPath: source, changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'verification', state: 'idle', threadId: 'fixture', reviewedVersion: null, createdAt: '', updatedAt: '', executionPath,
    workspace: { version: 1, kind: 'git-worktree', status: 'ready', profileId, rootId: registered.rootId, rootPath, managedPath: registered.managedPath, projectId, workspaceId, executionPath, commonDir: join(source, '.git'), branch, baseCommit: head, workspaceBaselineCommit: head, sourcePlanRevision: collectWorkspaceDocuments(source, 'a').planRevision },
    verificationCommands: [{ id: 'fixture', command: 'fixture', args: [] }], workVerificationCommands: [] };
  identityPath = join(container, 'identity.json'); identity = JSON.stringify({ schemaVersion: 1, workId: 'a', projectPath: source, ...original.workspace }); writeFileSync(identityPath, identity);
  docs = join(executionPath, 'openspec/changes/a'); store.save(original); original.reviewedVersion = works.planVersion(original); store.save(original); work = structuredClone(original);
  const command = (work.verificationCommands as any[])[0]; store.record('baseline-verification', 'a', 'verification', { commandId: command.id, status: 'passed', scope: 'full', revision: works.execution.revision(work), sourceMutationVersion: work.sourceMutationVersion, commandVersion: JSON.stringify(command), evidenceVersion: 1, processTerminated: true, terminationEvidence: 'job-and-worker-closed', contextVersion: works.execution.verificationContext(work, command) });
});
afterEach(() => { vi.restoreAllMocks(); work = structuredClone(original); store.save(work); writeFileSync(identityPath, identity); writeFileSync(join(docs, 'tasks.md'), '- [ ] task\n'); writeFileSync(join(docs, 'design.md'), '# Plan\n'); writeFileSync(join(work.executionPath!, 'code.ts'), 'export const value = 1;\n'); store.record('race-question', 'a', 'question', { status: 'answered' }); });
afterAll(async () => { await app?.close(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; });

it('문서 수가 늘어도 검토 해시의 Git 경계 검증은 시작과 종료 두 번으로 제한한다', () => {
  const check = vi.spyOn(WorkspaceService.prototype, 'path'); works.planVersion(work); const initial = check.mock.calls.length; check.mockClear();
  const extra = ['extra-1.md', 'extra-2.md', 'extra-3.md', 'extra-4.md'].map(name => join(docs, 'specs/demo', name));
  try { for (const name of extra) writeFileSync(name, '# Extra\n'); works.planVersion(work); expect(check).toHaveBeenCalledTimes(initial); expect(initial).toBe(2); }
  finally { for (const name of extra) unlinkSync(name); }
});
it('기존 문서 순서·해시와 체크박스 정규화를 유지하고 경로·CAS 검사를 생략하지 않는다', () => {
  const names = ['proposal.md', 'design.md', 'tasks.md', 'specs/demo/spec.md'];
  const expected = hash(names.map(name => `${name}\n${readFileSync(join(docs, name), 'utf8').replace(/- \[[xX ]\]/g, '- [ ]')}`).join('\n'));
  expect(works.planVersion(work)).toBe(expected); writeFileSync(join(docs, 'tasks.md'), '- [x] task\n'); expect(works.planVersion(work)).toBe(expected);
  expect(() => works.document('a', '../code.txt')).toThrow();
  expect(() => works.saveDocument('a', { path: 'proposal.md', version: 'stale', content: 'lost update' })).toThrow();
  expect(readFileSync(join(docs, 'proposal.md'), 'utf8')).toBe('# Plan\n');
});
it('검토 읽기 시작 후 소유 identity가 바뀌면 끝 경계에서 거부한다', () => {
  const path = WorkspaceService.prototype.path; let first = true;
  vi.spyOn(WorkspaceService.prototype, 'path').mockImplementation(function (this: WorkspaceService, value: Work) { const result = path.call(this, value); if (first) { first = false; writeFileSync(identityPath, identity.replace('"workId":"a"', '"workId":"foreign"')); } return result; });
  expect(() => works.planVersion(work)).toThrow(/복구/);
});
it('검토 읽기 시작 후 저장된 업무 경로가 바뀌면 이전 공간의 증명을 재사용하지 않는다', () => {
  const path = WorkspaceService.prototype.path; let first = true;
  vi.spyOn(WorkspaceService.prototype, 'path').mockImplementation(function (this: WorkspaceService, value: Work) { const result = path.call(this, value); if (first) { first = false; store.save({ ...store.get('a')!, executionPath: 'missing' }); } return result; });
  expect(() => works.planVersion(work)).toThrow();
});
it('공유 링크 문서와 실제 Git 등록 변경을 계속 거부한다', () => {
  const linked = join(docs, 'linked.txt'); linkSync(join(docs, 'proposal.md'), linked);
  try { expect(() => works.planVersion(work)).toThrow(/링크|소유/); } finally { unlinkSync(linked); }
  git(work.executionPath!, 'checkout', '--detach');
  try { expect(() => works.planVersion(work)).toThrow(/복구/); } finally { git(work.executionPath!, 'checkout', work.workspace!.branch!); }
});
it('업무 GET은 변경 보고서를 한 번만 수집하고 결과와 같은 파일 목록을 제공한다', () => {
  const report = vi.spyOn(works.execution, 'changeReport'), snapshot = vi.spyOn(works.execution, 'revision');
  const result = app.get(WorkController).get('a'); expect(report).toHaveBeenCalledTimes(1); expect(result.changes).toEqual(result.changeReport.files); expect(result.reviewRequired).toBe(false); expect(result.verifications[0].fresh).toBe(true); expect(snapshot).not.toHaveBeenCalled();
});
it('유도한 작업 명령과 결과도 동일 조회의 변경 파일·명령 목록을 재사용한다', () => {
  delete work.workVerificationCommands; store.save(work); writeFileSync(join(work.executionPath!, 'code.ts'), 'export const value = 2;\n');
  const expected = works.execution.commands(work, 'work'); expect(expected.length).toBeGreaterThan(0);
  const report = vi.spyOn(works.execution, 'changeReport'), changes = vi.spyOn(works.execution, 'changes'), commands = vi.spyOn(works.execution, 'commands');
  const result = app.get(WorkController).get('a'); expect(result.workVerificationCommands).toEqual(expected); expect(result.verifications[0].fresh).toBe(false); expect(report).toHaveBeenCalledTimes(1); expect(changes).not.toHaveBeenCalled(); expect(commands).toHaveBeenCalledTimes(2);
});
it('공간이 불가능하면 문서·명령·검증 freshness의 unavailable 분기를 유지한다', () => {
  writeFileSync(identityPath, identity.replace('"workId":"a"', '"workId":"foreign"'));
  const result = app.get(WorkController).get('a'); expect(result.recovery.code).toBe('workspace-unavailable'); expect(result.documents).toEqual([]); expect(result.verificationCommands).toEqual([]); expect(result.workVerificationCommands).toEqual([]); expect(result.verifications.every((row: any) => row.fresh === false)).toBe(true); expect(result.changeReport.source).toBe('unavailable'); expect(result.changes).toEqual([]);
});
it('full 검증 gate는 기본 작업 명령을 유도하거나 변경 보고서를 별도로 만들지 않는다', async () => {
  delete work.workVerificationCommands; store.save(work);
  const commands = vi.spyOn(works.execution, 'commands'), report = vi.spyOn(works.execution, 'changeReport');
  const result = await works.integrationReadiness('a', work.reviewedVersion!);
  expect(result.workVerificationRefs).toEqual(['baseline-verification']); expect(report).not.toHaveBeenCalled(); expect(commands.mock.calls.every(call => call[1] !== 'work')).toBe(true);
});
it('내부에서 캡처한 revision은 버릴 snapshot을 만들지 않고 freshness에 사용한다', () => {
  const command = { id: 'captured-command', command: 'fixture', args: [] }; work.verificationCommands = [command]; store.record('verified', 'a', 'verification', { commandId: command.id, status: 'passed', scope: 'full', revision: 'captured', sourceMutationVersion: work.sourceMutationVersion, commandVersion: JSON.stringify(command), evidenceVersion: 1, processTerminated: true, terminationEvidence: 'job-and-worker-closed', contextVersion: works.execution.verificationContext(work, command) });
  const snapshot = vi.spyOn(works.execution, 'revision'); expect(works.execution.results(work, 'captured').find(row => row.id === 'verified')!.fresh).toBe(true); expect(snapshot).not.toHaveBeenCalled();
  works.execution.results(work); expect(snapshot).toHaveBeenCalledTimes(1);
});
it.each(['source', 'plan', 'work', 'question'])('검증 await 뒤 %s 변경은 readiness를 계속 차단한다', async changed => {
  let release!: () => void;
  vi.spyOn(works.browser, 'assertPassed').mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = works.integrationReadiness('a', work.reviewedVersion!); const outcome = pending.then(() => null, error => error);
  expect(release).toBeTypeOf('function');
  if (changed === 'source') writeFileSync(join(work.executionPath!, 'code.ts'), 'export const value = 3;\n');
  if (changed === 'plan') writeFileSync(join(docs, 'design.md'), '# Changed\n');
  if (changed === 'work') { const latest = store.get('a')!; latest.state = 'running'; store.save(latest); }
  if (changed === 'question') store.record('race-question', 'a', 'question', { status: 'pending' });
  release(); const error = await outcome; expect(error).toBeInstanceOf(Error); expect(error.message).toMatch(changed === 'question' ? /질문/ : /변경/);
});
it('완료·보관 문서는 현재 공간이 없어도 저장된 내용과 해시를 조회한다', () => {
  for (const phase of ['completed', 'archived']) {
    const saved = { path: 'proposal.md', content: '# Saved\n', version: hash('# Saved\n') };
    const historical = { ...work, phase, executionPath: 'missing', completedDocuments: { 'proposal.md': saved } }; store.save(historical);
    expect(works.document('a', 'proposal.md')).toEqual(saved); expect(works.documents(historical)).toEqual(['proposal.md']); expect(works.planVersion(historical)).toBe(hash('proposal.md\n# Saved\n'));
  }
});

it('명시한 작업 검증을 완료 조건과 통합 예약 근거에 동일하게 사용한다', async () => {
  const command = { id: 'focused-plan', command: process.execPath, args: ['-e', 'process.exit(0)'] };
  work.verificationScope = 'work'; work.workVerificationCommands = [command]; store.save(work);
  store.record('focused-proof', work.id, 'verification', { commandId: command.id, scope: 'work', status: 'passed', revision: works.execution.revision(work), sourceMutationVersion: work.sourceMutationVersion, commandVersion: JSON.stringify(command), evidenceVersion: 1, processTerminated: true, terminationEvidence: 'job-and-worker-closed', contextVersion: works.execution.verificationContext(work, command) });
  expect((await works.integrationReadiness(work.id, work.reviewedVersion!)).workVerificationRefs).toEqual(['focused-proof']);
});
