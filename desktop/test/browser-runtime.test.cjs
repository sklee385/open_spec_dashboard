const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { stageBrowserRuntime } = require('../browser-runtime.cjs');
test('브라우저가 없으면 패키징을 거부하고 정확한 버전의 실행 파일을 복사한다', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'browser-stage-'));
  const metadata = join(root, 'node_modules/playwright-core'); fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(join(metadata, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium', revision: '123' }] }));
  const destination = join(root, 'stage/browser-runtime');
  assert.throws(() => stageBrowserRuntime(root, destination), /setup-browser/);
  const folder = join(root, '.tools/browser-runtime/chromium-123/chrome-win64'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(join(folder, 'chrome.exe'), 'fixture');
  assert.throws(() => stageBrowserRuntime(root, destination), /setup-browser/);
  const guard = join(root, '.tools/browser-runtime/guard'); fs.mkdirSync(guard); fs.writeFileSync(join(guard, 'BrowserGuard.exe'), 'guard fixture');
  stageBrowserRuntime(root, destination);
  assert.equal(fs.readFileSync(join(destination, 'chromium-123/chrome-win64/chrome.exe'), 'utf8'), 'fixture');
});
