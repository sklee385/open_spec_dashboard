import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { projectCoordinator } from '../src/projects/coordinator';
import type { Work, WorkStore } from '../src/work/store';
afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'project-coordinator-'));
  const work: Work = { id: 'work', sourceId: 'demo', projectPath: root, changeName: 'feature', requestKey: 'w', ideaIds: [], phase: 'implementation', state: 'idle', threadId: null, reviewedVersion: null, createdAt: '', updatedAt: '' };
  const works = [work];
  const records: any[] = [];
  const store = { list: () => works, records: (_id: string, kind: string) => records.filter(row => row.kind === kind) } as unknown as WorkStore;
  return { root, work, works, records, store, coordinator: projectCoordinator(store) };
}

it('같은 store의 두 요청은 실경로 잠금을 공유하고 중복 변경을 거부한다', () => {
  const { root, store, coordinator } = fixture();
  expect(projectCoordinator(store)).toBe(coordinator);
  const release = coordinator.acquire(root);
  expect(() => coordinator.acquire(join(root, '.'))).toThrow();
  release(); release();
  expect(() => coordinator.acquire(root)()).not.toThrow();
});

it.each(['connecting', 'creating-thread', 'running', 'waiting-input', 'waiting-approval', 'recovery-required'])('%s 업무가 있으면 파일·Git 변경을 막고 업무를 표시한다', state => {
  const { root, work, coordinator } = fixture(); work.state = state;
  expect(() => coordinator.acquire(root)).toThrow(/work|업무/);
});

it('idle 상태여도 미해결 질문이나 실행 중 검증이 있으면 변경을 막는다', () => {
  const { root, records, coordinator } = fixture();
  records.push({ kind: 'question', status: 'pending' });
  expect(() => coordinator.acquire(root)).toThrow();
  records.length = 0; records.push({ kind: 'verification', status: 'running' });
  expect(() => coordinator.acquire(root)).toThrow();
});

it('Git 변경 잠금 중에는 AI·검증 시작을 거부하고 해제 후 허용한다', () => {
  const { root, work, coordinator } = fixture();
  const release = coordinator.acquire(root);
  expect(() => coordinator.assertWorkCanStart(work)).toThrow();
  release(); expect(() => coordinator.assertWorkCanStart(work)).not.toThrow();
});

it('별도 실행 폴더의 잠금도 원본 업무 AI·검증 시작에서 확인한다', () => {
  const { work, coordinator } = fixture();
  work.executionPath = mkdtempSync(join(tmpdir(), 'project-coordinator-isolated-'));
  const release = coordinator.acquire(work.executionPath);
  expect(() => coordinator.assertWorkCanStart(work)).toThrow(); release();
});

it('linked worktree는 공통 Git 디렉터리의 변경 잠금을 공유한다', () => {
  const { root, coordinator } = fixture();
  const other = join(root, 'linked');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base'], { cwd: root, windowsHide: true });
  execFileSync('git', ['worktree', 'add', '-b', 'other', other], { cwd: root, windowsHide: true });
  const release = coordinator.acquire(root);
  expect(() => coordinator.acquire(other)).toThrow(); release();
  expect(() => coordinator.acquire(other)()).not.toThrow();
  vi.stubEnv('PATH', mkdtempSync(join(tmpdir(), 'coordinator-without-git-')));
  const offlineRelease = coordinator.acquire(root);
  expect(() => coordinator.acquire(other)).toThrow(); offlineRelease();
});

it('관계없는 프로젝트 작업은 막지 않는다', () => {
  const { root, coordinator } = fixture();
  const other = mkdtempSync(join(tmpdir(), 'project-coordinator-other-')); mkdirSync(join(other, 'openspec'));
  const release = coordinator.acquire(root);
  expect(() => coordinator.acquire(other)()).not.toThrow(); release();
});

it('불확실 상태는 명시적 실제 상태 확인 전까지 막고 확인 후 해제한다', () => {
  const { root, work, coordinator } = fixture(); coordinator.block(root);
  expect(() => coordinator.acquire(root)).toThrow(); expect(() => coordinator.assertWorkCanStart(work)).toThrow();
  coordinator.unblock(root); expect(() => coordinator.acquire(root)()).not.toThrow();
});

it('서버 재시작 후 남은 미확인 Git 기록도 AI·검증 시작을 막는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'project-coordinator-records-')); vi.stubEnv('DATA_DIR', dir);
  const { root, work, coordinator } = fixture(); const records = join(dir, 'project-git-operations'); mkdirSync(records);
  const target = join(records, 'uncertain.json');
  writeFileSync(target, JSON.stringify({ root, state: 'uncertain', status: 'uncertain', id: 'lost', kind: 'push' }));
  expect(() => coordinator.assertWorkCanStart(work)).toThrow();
  expect(() => coordinator.acquire(root)).toThrow();
  writeFileSync(target, JSON.stringify({ root, state: 'uncertain', status: 'uncertain', reviewedAt: 'confirmed' }));
  expect(() => coordinator.assertWorkCanStart(work)).not.toThrow();
});
