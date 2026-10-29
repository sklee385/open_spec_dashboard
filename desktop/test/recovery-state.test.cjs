const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { RecoveryState, HealthJournal } = require('../recovery-state.cjs');

test('비정상 시작은 안전 모드이고 정상 종료와 명시적 해제를 기록한다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-state-'));
  const first = new RecoveryState(directory);
  assert.equal(first.safeStartup, false); first.started();
  const crashed = new RecoveryState(directory);
  assert.equal(crashed.safeStartup, true); crashed.started(); crashed.setSafeMode(false); crashed.stopped();
  assert.equal(new RecoveryState(directory).safeStartup, false);
  writeFileSync(join(directory, 'recovery-state.json'), '{');
  assert.equal(new RecoveryState(directory).safeStartup, true);
  for (const value of ['{}', 'null', 'false', '{"unclean":false}']) {
    writeFileSync(join(directory, 'recovery-state.json'), value);
    assert.equal(new RecoveryState(directory).safeStartup, true);
  }
});

test('장애 기록은 제한된 상태 메타데이터만 보관하고 원문과 토큰을 제외한다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-journal-'));
  const journal = new HealthJournal(directory);
  for (let i = 0; i < 140; i++) journal.record('screen-error', { code: 'unresponsive', workId: 'work-1', text: 'PRIVATE_PROMPT', token: 'PRIVATE_TOKEN', stderr: 'PRIVATE_STDERR' });
  assert.equal(journal.list().length, 120);
  const saved = readFileSync(journal.path, 'utf8');
  assert.doesNotMatch(saved, /PRIVATE_/);
  assert.equal(new HealthJournal(directory).list().length, 120);
});
