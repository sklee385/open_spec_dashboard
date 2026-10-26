const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { prepareStageDirectory } = require('../stage-directory.cjs');

test('깨끗한 checkout에서 .tools가 없어도 고정 스테이징 경로를 준비한다', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'desktop-stage-root-'));
  const stage = prepareStageDirectory(root);
  assert.equal(stage, join(root, '.tools', 'desktop-stage'));
  assert.ok(fs.statSync(stage).isDirectory());
  fs.writeFileSync(join(stage, 'old'), 'old');
  fs.writeFileSync(join(root, '.tools', 'preserved'), 'keep');
  prepareStageDirectory(root);
  assert.equal(fs.existsSync(join(stage, 'old')), false);
  assert.equal(fs.readFileSync(join(root, '.tools', 'preserved'), 'utf8'), 'keep');
});

test('도구 폴더나 스테이징 경로가 링크이면 외부 파일을 삭제하지 않는다', () => {
  for (const linkedTools of [true, false]) {
    const root = fs.mkdtempSync(join(tmpdir(), 'desktop-stage-root-'));
    const outside = fs.mkdtempSync(join(tmpdir(), 'desktop-stage-outside-'));
    fs.writeFileSync(join(outside, 'preserved'), 'keep');
    if (!linkedTools) fs.mkdirSync(join(root, '.tools'));
    fs.symlinkSync(outside, linkedTools ? join(root, '.tools') : join(root, '.tools', 'desktop-stage'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => prepareStageDirectory(root), /링크/);
    assert.equal(fs.readFileSync(join(outside, 'preserved'), 'utf8'), 'keep');
  }
});

test('분리 빌드는 기본 실행 폴더를 보존하고 허용된 이름만 사용한다', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'desktop-stage-root-'));
  const original = prepareStageDirectory(root);
  fs.writeFileSync(join(original, 'running'), 'keep');
  const isolated = prepareStageDirectory(root, 'desktop-stage-shutdown');
  assert.notEqual(isolated, original);
  assert.equal(fs.readFileSync(join(original, 'running'), 'utf8'), 'keep');
  assert.equal(isolated, join(root, '.tools', 'desktop-stage-shutdown'));
  for (const name of ['', '..', '../data', 'desktop-stage/../data', 'data', 'C:\\data']) {
    assert.throws(() => prepareStageDirectory(root, name), /경로|이름/);
  }
});
