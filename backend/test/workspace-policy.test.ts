import { expect, it } from 'vitest';
import type { Work, WorkStore } from '../src/work/store';
import { desktopHealth } from '../src/desktop/health';
import { assertActiveCapacity, assertPreparationCapacity, assertCandidateCapacity, retentionSuggestion } from '../src/work/workspace-policy';
const policy = { maxActiveWorks: 3, minimumFreeBytes: 5 * 1024 ** 3, retentionDays: 14 };
const work = (id: string, state: string): Work => ({ id, state, sourceId: 's', projectPath: '/source', requestKey: id, changeName: id, ideaIds: [], phase: 'implementation', threadId: id, reviewedVersion: 'plan', createdAt: '', updatedAt: '' });
it('질문·승인·준비·검증을 활성으로 세고 중단 공간은 제외하며 한도 축소가 기존 실행을 종료하지 않는다', () => {
  const running = work('a', 'running'), waiting = work('b', 'idle'), interrupted = work('c', 'interrupted'), starting = work('d', 'idle');
  const store = { list: () => [running, waiting, interrupted, starting], records: (id: string, kind: string) => id === 'b' && kind === 'question' ? [{ status: 'pending' }] : [] } as unknown as WorkStore;
  expect(() => assertActiveCapacity(starting, policy, store)).not.toThrow();
  expect(() => assertActiveCapacity(starting, { ...policy, maxActiveWorks: 2 }, store)).toThrow(/대기/);
  expect(() => assertActiveCapacity(running, { ...policy, maxActiveWorks: 1 }, store)).not.toThrow();
  expect(running.state).toBe('running'); expect(interrupted.state).toBe('interrupted');
  interrupted.workspace = { status: 'preparing' } as any;
  expect(() => assertActiveCapacity(starting, policy, store)).toThrow(/대기/);
});
it('미확인·부족 잔여는 준비를 막고 후보는 활성 업무 한도와 별도로 저장소당 하나만 허용한다', () => {
  expect(() => assertPreparationCapacity({ confirmed: false, available: true, freeBytes: policy.minimumFreeBytes }, policy)).toThrow(/확인/);
  expect(() => assertPreparationCapacity({ confirmed: true, available: true, freeBytes: null }, policy)).toThrow(/용량/);
  expect(() => assertPreparationCapacity({ confirmed: true, available: true, freeBytes: policy.minimumFreeBytes - 1 }, policy)).toThrow(/용량/);
  expect(() => assertPreparationCapacity({ confirmed: true, available: true, freeBytes: policy.minimumFreeBytes }, policy)).not.toThrow();
  const candidates = [{ id: 'existing', commonDir: '/repo/.git', status: 'validating' }];
  expect(() => assertCandidateCapacity('/repo/.git', candidates)).toThrow(/후보/);
  expect(() => assertCandidateCapacity('/repo/.git', candidates, 'existing')).not.toThrow();
  expect(() => assertCandidateCapacity('/other/.git', candidates)).not.toThrow();
});
it('기간 경과는 자료 정리 제안만 반환하고 파일 삭제를 수행하지 않는다', () => {
  const expired = '2026-10-01T00:00:00Z';
  expect(retentionSuggestion(expired, policy, Date.parse('2026-10-27T00:00:00Z'))).toMatchObject({ suggested: true, automatic: false });
  expect(retentionSuggestion('2026-10-26T00:00:00Z', policy, Date.parse('2026-10-27T00:00:00Z')).suggested).toBe(false);
  expect(retentionSuggestion('invalid', policy).suggested).toBe(false);
});

it('계획 대화는 구현·검증 한도를 소비하지 않고 한도 초과 시에도 계획 요청은 허용한다', () => {
  const plan = { ...work('plan', 'running'), phase: 'planning' }, running = work('running', 'running'), starting = work('new', 'idle');
  const store = { list: () => [plan, running], records: () => [] } as unknown as WorkStore;
  expect(() => assertActiveCapacity(starting, { ...policy, maxActiveWorks: 2 }, store)).not.toThrow();
  expect(() => assertActiveCapacity({ ...starting, phase: 'planning' }, { ...policy, maxActiveWorks: 1 }, store)).not.toThrow();
  expect(() => assertActiveCapacity(starting, { ...policy, maxActiveWorks: 1 }, store)).toThrow(/대기/);
});

it.each(['active', 'unknown'] as const)('종료 미확인 복구 업무의 실제 %s 실행은 활성 한도에 포함한다', runtime => {
  const owner = { ...work('owner', 'recovery-required'), executionUnconfirmed: true }, starting = work('new', 'idle');
  const store = { list: () => [owner, starting], records: () => [] } as unknown as WorkStore;
  desktopHealth(store).register('runtime-fixture', candidate => candidate.id === owner.id ? runtime : 'inactive');
  expect(() => assertActiveCapacity(starting, { ...policy, maxActiveWorks: 1 }, store)).toThrow(/대기/);
});
it('실행하지 않은 외부 writer 점유만의 복구 업무는 활성 슬롯을 사용하지 않는다', () => {
  const owner = { ...work('owner', 'recovery-required'), errorCode: 'thread-in-use', executionUnconfirmed: false }, starting = work('new', 'idle');
  const store = { list: () => [owner, starting], records: () => [] } as unknown as WorkStore;
  desktopHealth(store).register('runtime-fixture', () => 'inactive');
  expect(() => assertActiveCapacity(starting, { ...policy, maxActiveWorks: 1 }, store)).not.toThrow();
});

it.each([undefined, false])('실제 runtime unknown은 과거 executionUnconfirmed=%s 값으로 슬롯에서 제외하지 않는다', executionUnconfirmed => {
  const owner = { ...work('legacy', 'recovery-required'), executionUnconfirmed }, starting = work('new', 'idle');
  const store = { list: () => [owner, starting], records: () => [] } as unknown as WorkStore;
  desktopHealth(store).register('actual-runtime', candidate => candidate.id === owner.id ? 'unknown' : 'inactive');
  expect(() => assertActiveCapacity(starting, { ...policy, maxActiveWorks: 1 }, store)).toThrow(/대기/);
});
