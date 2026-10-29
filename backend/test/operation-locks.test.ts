import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { WorkStore, type Work } from '../src/work/store';
import { projectCoordinator } from '../src/projects/coordinator';
vi.setConfig({ testTimeout: 15000 });
let dir: string, source: string, a: Work, b: Work, store: WorkStore;
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'k-')); source = join(dir, 's'); mkdirSync(source); process.env.DATA_DIR = join(dir, 'data'); store = new WorkStore();
  git(source, 'init', '-b', 'main'); git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'base');
  const make = (id: string): Work => { const root = join(dir, id); git(source, 'worktree', 'add', '-b', `work-${id}`, root); const work: Work = { id, sourceId: 'demo', projectPath: source, executionPath: root, changeName: id === 'a' ? 'alpha' : 'beta', requestKey: id, ideaIds: [], phase: 'implementation', state: 'idle', threadId: `thread-${id}`, reviewedVersion: 'review', createdAt: '', updatedAt: '' }; store.save(work); return work; };
  a = make('a'); b = make('b');
});
afterEach(() => { store.onApplicationShutdown(); delete process.env.DATA_DIR; });
it('A 질문 대기는 같은 공간만 막고 독립 B 공간의 쓰기·index를 허용한다', () => {
  a.state = 'waiting-input'; store.save(a); store.record('question', a.id, 'question', { status: 'pending' }); const coordinator = projectCoordinator(store);
  expect(() => coordinator.acquireOperation({ kind: 'workspace', root: a.executionPath! })).toThrow(/업무|실행/);
  const release = coordinator.acquireOperation({ kind: 'workspace', root: b.executionPath! });
  expect(() => coordinator.acquireOperation({ kind: 'index', root: b.executionPath! })).toThrow(); release();
  expect(() => coordinator.acquireOperation({ kind: 'index', root: b.executionPath! })()).not.toThrow();
});
it('원본 계획 문서는 변경별 잠금이며 같은 변경과 상위 공간 쓰기만 충돌한다', () => {
  a.phase = b.phase = 'planning'; delete a.executionPath; delete b.executionPath; a.state = 'waiting-input'; store.save(a); store.save(b); const coordinator = projectCoordinator(store);
  expect(() => coordinator.acquireOperation({ kind: 'documents', root: source, changeName: 'alpha' })).toThrow();
  expect(() => coordinator.acquireOperation({ kind: 'documents', root: source, changeName: 'beta' })()).not.toThrow();
  expect(() => coordinator.acquireOperation({ kind: 'workspace', root: source })).toThrow();
});
it('공유 관리·같은 ref는 직렬화하고 별도 업무 ref의 index는 병행한다', () => {
  const coordinator = projectCoordinator(store), ref = 'refs/heads/shared';
  const release = coordinator.acquireOperation({ kind: 'index', root: a.executionPath!, refs: [ref] });
  expect(() => coordinator.acquireOperation({ kind: 'index', root: b.executionPath!, refs: [ref] })).toThrow();
  expect(() => coordinator.acquireOperation({ kind: 'index', root: b.executionPath!, refs: ['refs/heads/other'] })()).not.toThrow();
  expect(() => coordinator.acquireOperation({ kind: 'management', root: source, refs: [ref] })).toThrow(); release();
  const management = coordinator.acquireOperation({ kind: 'management', root: source });
  expect(() => coordinator.acquireOperation({ kind: 'management', root: b.executionPath! })).toThrow();
  expect(() => coordinator.acquireOperation({ kind: 'integration', root: source })).toThrow(); management();
});
it('통합→관리→정렬 공간 순서를 고정하고 역순 중첩을 거부한다', () => {
  const coordinator = projectCoordinator(store);
  const plan = coordinator.operationPlan({ kind: 'integration', root: source, spaces: [b.executionPath!, a.executionPath!] });
  expect(plan.map(resource => resource.order)).toEqual([...plan.map(resource => resource.order)].sort((x, y) => x - y));
  expect(plan.filter(resource => resource.kind === 'space').map(resource => resource.root)).toEqual([...plan.filter(resource => resource.kind === 'space').map(resource => resource.root)].sort());
  const release = coordinator.acquireOperation({ kind: 'workspace', root: a.executionPath! }, 'owner');
  expect(() => coordinator.acquireOperation({ kind: 'management', root: source }, 'owner')).toThrow(/순서/); release();
});
it('범위가 기록된 uncertain과 로컬 준비 프로세스는 영향 공간만 차단한다', () => {
  const records = join(process.env.DATA_DIR!, 'project-git-operations'); mkdirSync(records);
  writeFileSync(join(records, 'uncertain.json'), JSON.stringify({ root: a.executionPath, commonDir: join(source, '.git'), scope: 'index', refs: ['refs/heads/work-a'], state: 'uncertain' }));
  const coordinator = projectCoordinator(store);
  expect(() => coordinator.acquireOperation({ kind: 'workspace', root: a.executionPath! })).toThrow(/미확인/);
  expect(() => coordinator.acquireOperation({ kind: 'workspace', root: b.executionPath! })()).not.toThrow();
  store.record('process', b.id, 'workspace-local-process', { executionPath: b.executionPath, status: 'uncertain', pid: 123 });
  expect(() => coordinator.acquireOperation({ kind: 'workspace', root: b.executionPath! })).toThrow(/프로세스|미확인/);
});
it('기존 공통 잠금과 새 범위 잠금도 서로 충돌하여 과도기 우회를 허용하지 않는다', () => {
  const coordinator = projectCoordinator(store), old = coordinator.acquire(source);
  expect(() => coordinator.acquireOperation({ kind: 'workspace', root: a.executionPath! })).toThrow(); old();
  const scoped = coordinator.acquireOperation({ kind: 'workspace', root: a.executionPath! });
  expect(() => coordinator.acquire(source)).toThrow(); expect(() => coordinator.assertWorkCanStart(a)).toThrow(); scoped();
});
it('비Git 상위 기존 잠금도 하위 변경 문서 잠금을 양방향 차단한다', () => {
  const root = join(dir, 'plain'); mkdirSync(root); const coordinator = projectCoordinator(store);
  const release = coordinator.acquire(root);
  expect(() => coordinator.acquireOperation({ kind: 'documents', root, changeName: 'alpha' })).toThrow(); release();
  const scoped = coordinator.acquireOperation({ kind: 'documents', root, changeName: 'alpha' });
  expect(() => coordinator.acquire(root)).toThrow(); scoped();
  coordinator.block(root);
  expect(() => coordinator.acquireOperation({ kind: 'documents', root, changeName: 'alpha' })).toThrow(); coordinator.unblock(root);
});
it('같은 실제 브랜치의 symbolic ref 별칭도 index 잠금을 공유한다', () => {
  git(source, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/work-a');
  git(b.executionPath!, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
  const coordinator = projectCoordinator(store), release = coordinator.acquireOperation({ kind: 'index', root: a.executionPath! });
  expect(() => coordinator.acquireOperation({ kind: 'index', root: b.executionPath! })).toThrow(); release();
});
it('명시 ref 목록으로 현재 HEAD 잠금을 빠뜨릴 수 없다', () => {
  git(b.executionPath!, 'symbolic-ref', 'HEAD', 'refs/heads/work-a');
  const coordinator = projectCoordinator(store), release = coordinator.acquireOperation({ kind: 'index', root: a.executionPath!, refs: [] });
  expect(() => coordinator.acquireOperation({ kind: 'index', root: b.executionPath!, refs: ['refs/heads/other'] })).toThrow(); release();
});
it('다른 저장소의 손상된 HEAD는 독립 공간의 시작을 막지 않는다', () => {
  a.state = 'running'; store.save(a);
  const headPointer = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'HEAD'], { cwd: a.executionPath!, encoding: 'utf8' }).trim(); writeFileSync(headPointer, 'broken');
  const plain = join(dir, 'plain'); mkdirSync(plain);
  expect(() => projectCoordinator(store).acquireOperation({ kind: 'workspace', root: plain })()).not.toThrow();
  expect(() => projectCoordinator(store).acquireOperation({ kind: 'workspace', root: b.executionPath! })).toThrow();
});
it('한글과 점을 포함하는 정상 브랜치의 잠금도 허용한다', () => {
  git(a.executionPath!, 'branch', '-m', 'feature/릴리스.v1/작업');
  expect(() => projectCoordinator(store).acquireOperation({ kind: 'index', root: a.executionPath! })()).not.toThrow();
});
it('공유 관리 작업이 명시한 symbolic ref 별칭도 실제 대상 ref와 충돌한다', () => {
  git(source, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/work-b');
  const coordinator = projectCoordinator(store), release = coordinator.acquireOperation({ kind: 'index', root: b.executionPath! });
  expect(() => coordinator.acquireOperation({ kind: 'management', root: source, refs: ['refs/heads/alias'] })).toThrow(); release();
});
