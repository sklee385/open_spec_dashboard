const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { configureGraphics } = require('../graphics.cjs');

test('프로필의 그래픽 가속 끄기 설정을 앱 준비 전에 적용한다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-graphics-'));
  let disabled = 0;
  const app = { commandLine: { appendSwitch(name) { assert.equal(name, 'disable-gpu'); disabled++; } } };
  configureGraphics(app, directory, 'linux');
  assert.equal(disabled, 0);
  writeFileSync(join(directory, 'graphics.json'), JSON.stringify({ hardwareAcceleration: false }));
  configureGraphics(app, directory, 'linux');
  assert.equal(disabled, 1);
  writeFileSync(join(directory, 'graphics.json'), JSON.stringify({ hardwareAcceleration: true }));
  configureGraphics(app, directory, 'linux');
  assert.equal(disabled, 1);
});

test('손상되거나 관계없는 설정으로 앱 시작을 막거나 가속을 임의로 끄지 않는다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-graphics-'));
  const app = { commandLine: { appendSwitch() { assert.fail('명시적인 false만 적용해야 한다'); } } };
  for (const value of ['{', '{}', '{"hardwareAcceleration":"false"}']) {
    writeFileSync(join(directory, 'graphics.json'), value);
    configureGraphics(app, directory, 'linux');
  }
});

test('Windows는 설정이 없거나 손상돼도 안전 모드가 기본이며 true만 가속을 허용한다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-graphics-win-'));
  const switches = [];
  const app = { commandLine: { appendSwitch(name) { switches.push(name); } } };
  configureGraphics(app, directory, 'win32');
  for (const value of ['{', '{}', '{"hardwareAcceleration":"true"}', '{"hardwareAcceleration":false}']) {
    writeFileSync(join(directory, 'graphics.json'), value);
    configureGraphics(app, directory, 'win32');
  }
  assert.deepEqual(switches, Array(5).fill('disable-gpu'));
  writeFileSync(join(directory, 'graphics.json'), '{"hardwareAcceleration":true}');
  configureGraphics(app, directory, 'win32');
  assert.equal(switches.length, 5);
});
