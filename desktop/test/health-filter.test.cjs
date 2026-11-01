const { test } = require('node:test');
const assert = require('node:assert/strict');
const { archivedNormal, filterWorks } = require('../health-filter.cjs');
const normal = { phase: 'planning', managementState: 'automatic', status: 'normal', runtime: 'inactive', state: 'idle', hasError: false, reasons: [], canRecover: false, canInterrupt: false };
test('실제 보관과 업무 범위 관리상 보관 중 명확히 정상인 행만 숨긴다', () => {
  assert.equal(archivedNormal(normal), false);
  assert.equal(archivedNormal({ ...normal, phase: 'completed' }), false);
  assert.equal(archivedNormal({ ...normal, phase: 'archived' }), true);
  assert.equal(archivedNormal({ ...normal, managementState: 'archived' }), true);
});
test('보관 중이어도 비정상·실행·미확인·경고·복구 또는 누락 근거는 유지한다', () => {
  for (const archive of [{ phase: 'archived' }, { managementState: 'archived' }]) {
    for (const patch of [{ status: 'unknown' }, { status: 'mismatch' }, { status: 'running' }, { runtime: 'unknown' }, { runtime: 'active' }, { state: 'failed' }, { state: 'running' }, { state: 'interrupted' }, { hasError: true }, { hasError: undefined }, { reasons: ['확인 필요'] }, { reasons: undefined }, { canRecover: true }, { canInterrupt: true }]) assert.equal(archivedNormal({ ...normal, ...archive, ...patch }), false, JSON.stringify({ archive, patch }));
  }
});
test('표시 집계와 추가 필터는 원본 진단 배열을 변경하지 않는다', () => {
  const works = [{ ...normal, phase: 'archived' }, { ...normal }, { ...normal, managementState: 'archived', runtime: 'unknown' }], before = JSON.stringify(works);
  assert.deepEqual(filterWorks(works), { visible: works.slice(1), hiddenArchivedCount: 1, filteredCount: 0 });
  assert.deepEqual(filterWorks(works, true), { visible: [works[2]], hiddenArchivedCount: 1, filteredCount: 1 });
  assert.equal(JSON.stringify(works), before); assert.deepEqual(filterWorks([]), { visible: [], hiddenArchivedCount: 0, filteredCount: 0 });
});
