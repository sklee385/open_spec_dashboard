import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../src/work/store';
import { DesktopLifecycle } from '../src/desktop/lifecycle';
import { desktopHealth } from '../src/desktop/health';

let store: WorkStore;
afterEach(() => { store?.onApplicationShutdown(); delete process.env.DATA_DIR; delete process.env.OPENSPEC_SAFE_MODE; });
function setup(state = 'recovery-required') {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'desktop-health-'));
  store = new WorkStore();
  store.save({ id: 'w', sourceId: 's', projectPath: '.', changeName: '업무', requestKey: 'w', ideaIds: [], phase: 'planning', state, threadId: 't', reviewedVersion: null, createdAt: '', updatedAt: '' });
  return new DesktopLifecycle(store);
}
it('실행 없음이 확인된 복구 필요 업무는 종료를 막지 않고 동기 상태 복구한다', () => {
  const lifecycle = setup(); desktopHealth(store).register('test', () => 'inactive');
  expect(lifecycle.diagnostics().works[0]).toMatchObject({ runtime: 'inactive', status: 'mismatch', canRecover: true });
  expect(lifecycle.status().idle).toBe(true);
  expect(lifecycle.recover('w')).toMatchObject({ state: 'interrupted' });
});
it('실제 실행과 불명확한 실행은 복구를 거절하고 완료 업무를 보존한다', () => {
  const lifecycle = setup();
  expect(lifecycle.diagnostics().works[0].runtime).toBe('unknown');
  expect(() => lifecycle.recover('w')).toThrow();
  desktopHealth(store).register('test', () => 'active');
  expect(() => lifecycle.recover('w')).toThrow();
  desktopHealth(store).register('test', () => 'inactive');
  store.save({ ...store.get('w')!, phase: 'completed' });
  expect(() => lifecycle.recover('w')).toThrow();
});
it('점검은 원문을 포함하거나 상태를 변경하지 않고 진행 질문을 보존한다', () => {
  const lifecycle = setup(); desktopHealth(store).register('test', () => 'inactive');
  store.record('q', 'w', 'question', { status: 'pending', kind: 'input', text: 'SECRET' });
  const before = JSON.stringify(store.get('w'));
  expect(JSON.stringify(lifecycle.diagnostics())).not.toContain('SECRET');
  expect(JSON.stringify(store.get('w'))).toBe(before);
  expect(() => lifecycle.recover('w')).toThrow();
});
it('안전 모드는 저장되며 해제와 복구는 종료 잠금 중 거절한다', () => {
  const lifecycle = setup('idle'); lifecycle.setSafeMode({ enabled: true });
  expect(new DesktopLifecycle(store).diagnostics().safeMode).toBe(true);
  lifecycle.prepare();
  expect(() => lifecycle.setSafeMode({ enabled: false })).toThrow();
});
it('안전 모드 해제는 기존 큐를 자동 재전송하지 않고 보존한다', () => {
  const lifecycle = setup('idle'); lifecycle.setSafeMode({ enabled: true });
  store.record('queued', 'w', 'queued-message', { status: 'queued', text: '보존할 원문' });
  lifecycle.setSafeMode({ enabled: false });
  expect(store.records('w', 'queued-message')[0]).toMatchObject({ status: 'blocked', text: '보존할 원문' });
});
it('환경 안전 모드는 저장 설정을 덮고 이후 시작에도 유지된다', () => {
  const lifecycle = setup('idle'); lifecycle.setSafeMode({ enabled: false });
  process.env.OPENSPEC_SAFE_MODE = '1';
  // A new store models a fresh service process, retaining the data directory.
  store.onApplicationShutdown(); store = new WorkStore();
  expect(new DesktopLifecycle(store).diagnostics().safeMode).toBe(true);
});
it('장애 이력은 재시작 뒤에도 제한된 메타데이터만 보존한다', () => {
  const lifecycle = setup('idle'); lifecycle.setSafeMode({ enabled: true });
  store.onApplicationShutdown(); store = new WorkStore();
  expect(new DesktopLifecycle(store).diagnostics().history).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'safe-mode-enabled' })]));
});
it('장애 기록은 허용 오류 코드만 저장하고 임의 원문을 제외한다', () => {
  const lifecycle = setup('idle');
  desktopHealth(store).event('execution-failed', 'w', 'failed', 'authentication-failed');
  desktopHealth(store).event('execution-failed', 'w', 'failed', 'SECRET raw stderr');
  const history = lifecycle.diagnostics().history;
  expect(history[0]).toMatchObject({ errorCode: 'authentication-failed' });
  expect(JSON.stringify(history)).not.toContain('SECRET');
});
it('사건 기록 저장 실패가 실행 종료 처리와 점검을 방해하지 않는다', () => {
  const lifecycle = setup('idle'); const health = desktopHealth(store);
  mkdirSync(join(process.env.DATA_DIR!, 'desktop-health.json'));
  expect(() => health.event('execution-failed', 'w', 'failed', 'execution-failed')).not.toThrow();
  expect(lifecycle.diagnostics().history.at(-1)?.type).toBe('history-storage-failed');
});
