import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { WorkStore, type Work } from '../src/work/store';
import { ProjectController } from '../src/projects/project.controller';
import { projectCoordinator } from '../src/projects/coordinator';
import { gitOperation } from '../src/projects/operation-scope';
vi.setConfig({ testTimeout: 20000 });
let dir: string, source: string, store: WorkStore, controller: ProjectController, a: Work, b: Work;
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c-')); source = join(dir, 's'); mkdirSync(source); process.env.DATA_DIR = join(dir, 'data'); store = new WorkStore();
  for (const name of ['alpha', 'beta']) { const docs = join(source, 'openspec/changes', name); mkdirSync(docs, { recursive: true }); writeFileSync(join(docs, 'proposal.md'), '# plan'); }
  writeFileSync(join(source, 'code.txt'), 'base'); git(source, 'init', '-b', 'main'); git(source, 'add', '--', '.'); git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base');
  const make = (id: string): Work => { const root = join(dir, id); git(source, 'worktree', 'add', '-b', `work-${id}`, root); const work: Work = { id, sourceId: 'demo', projectPath: source, executionPath: root, changeName: id === 'a' ? 'alpha' : 'beta', requestKey: id, ideaIds: [], phase: 'implementation', state: 'idle', threadId: `thread-${id}`, reviewedVersion: 'review', createdAt: '', updatedAt: '' }; store.save(work); return work; };
  a = make('a'); b = make('b');
  controller = new ProjectController({ resolve: (_source: string, id?: string) => ({ root: id ? store.get(id)!.executionPath : source }) } as any, store, { updates: { next() {} } } as any, { requests: 0 } as any);
});
afterEach(async () => { await controller.onModuleDestroy(); store.onApplicationShutdown(); delete process.env.DATA_DIR; });
it('실제 파일 호출부는 A 질문 중 B 저장을 허용하고 A 변경은 거부한다', async () => {
  a.state = 'waiting-input'; store.save(a); store.record('q', a.id, 'question', { status: 'pending' });
  const bFile = await controller.file('demo', b.id, 'code.txt');
  await expect(controller.save('demo', b.id, { ...bFile, content: 'B' })).resolves.toBeDefined();
  const aFile = await controller.file('demo', a.id, 'code.txt');
  await expect(controller.save('demo', a.id, { ...aFile, content: 'A' })).rejects.toThrow();
  expect(readFileSync(join(source, 'code.txt'), 'utf8')).toBe('base');
});
it('원본의 다른 변경 문서만 편집할 때 계획 질문과 충돌하지 않는다', async () => {
  a.phase = 'planning'; delete a.executionPath; a.state = 'waiting-input'; store.save(a);
  const path = 'openspec/changes/beta/proposal.md', file = await controller.file('demo', undefined, path);
  await expect(controller.save('demo', undefined, { ...file, content: '# beta edit' })).resolves.toBeDefined();
  const held = await controller.file('demo', undefined, 'openspec/changes/alpha/proposal.md');
  await expect(controller.save('demo', undefined, { ...held, content: '# no' })).rejects.toThrow();
});
it('영속 uncertain A index는 B 파일·AI 시작을 막지 않는다', async () => {
  const records = join(process.env.DATA_DIR!, 'project-git-operations'); mkdirSync(records, { recursive: true });
  writeFileSync(join(records, 'a0000000-0000-4000-8000-000000000001.json'), JSON.stringify({ id: 'a0000000-0000-4000-8000-000000000001', root: a.executionPath, commonDir: join(source, '.git'), scope: 'index', refs: ['refs/heads/work-a'], state: 'uncertain', status: 'uncertain' }));
  // Recreate the controller so its OperationStore sees the restart record.
  await controller.onModuleDestroy(); controller = new ProjectController({ resolve: (_: string, id?: string) => ({ root: id ? store.get(id)!.executionPath : source }) } as any, store, { updates: { next() {} } } as any, { requests: 0 } as any);
  const file = await controller.file('demo', b.id, 'code.txt');
  await expect(controller.save('demo', b.id, { ...file, content: 'B' })).resolves.toBeDefined();
  expect(() => projectCoordinator(store).assertActivityCanStart(b)).not.toThrow();
  expect(() => projectCoordinator(store).assertActivityCanStart(a)).toThrow();
});
it('새 Git intent는 실행 전에 당시 범위와 실제 ref를 영속 저장한다', async () => {
  writeFileSync(join(b.executionPath!, 'code.txt'), 'B'); const status = await controller.status('demo', b.id);
  const op = await controller.start('demo', b.id, { kind: 'stage', paths: ['code.txt'], requestKey: 'stage-b', token: status.token });
  const saved = JSON.parse(readFileSync(join(process.env.DATA_DIR!, 'project-git-operations', `${op.id}.json`), 'utf8'));
  expect(saved).toMatchObject({ scope: 'index', refs: ['refs/heads/work-b'], affectedRoots: [b.executionPath!] });
  await expect.poll(async () => (await controller.operation('demo', b.id, op.id)).status).toBe('succeeded');
});
it('같은 원본의 Alpha 문서 uncertain은 Beta 문서 저장만 허용한다', async () => {
  const records = join(process.env.DATA_DIR!, 'project-git-operations'); mkdirSync(records, { recursive: true });
  writeFileSync(join(records, 'alpha.json'), JSON.stringify({ root: source, scope: 'documents', changeName: 'alpha', refs: [], state: 'uncertain' }));
  const file = await controller.file('demo', undefined, 'openspec/changes/beta/proposal.md');
  await expect(controller.save('demo', undefined, { ...file, content: '# beta' })).resolves.toBeDefined();
  const alpha = await controller.file('demo', undefined, 'openspec/changes/alpha/proposal.md');
  await expect(controller.save('demo', undefined, { ...alpha, content: '# no' })).rejects.toThrow();
});
it('다른 업무의 pull도 공유 원격 추적 ref를 변경할 때 직렬화한다', () => {
  git(source, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); const coordinator = projectCoordinator(store);
  const request = gitOperation(a.executionPath!, { kind: 'pull', token: 'test', requestKey: 'pull-a' });
  expect(coordinator.operationPlan(request).filter(resource => resource.kind === 'ref').map(resource => resource.ref)).toContain('refs/remotes/origin/main');
  const release = coordinator.acquireOperation(request);
  expect(() => coordinator.acquireOperation(gitOperation(b.executionPath!, { kind: 'pull', token: 'test', requestKey: 'pull-b' }))).toThrow(); release();
});
