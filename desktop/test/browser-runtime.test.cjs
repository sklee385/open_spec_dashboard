const { createHash } = require('node:crypto');
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
  fs.mkdirSync(join(root,'backend/scripts'),{recursive:true}); fs.writeFileSync(join(root,'backend/scripts/BrowserGuard.cs'),'source fixture');
  fs.writeFileSync(join(guard,'BrowserGuard.build.json'),JSON.stringify({schemaVersion:1,protocol:'browser-job-v2-witness-v1',sourceSha256:createHash('sha256').update('source fixture').digest('hex'),binarySha256:createHash('sha256').update('guard fixture').digest('hex')}));
  stageBrowserRuntime(root, destination);
  assert.equal(fs.readFileSync(join(destination, 'chromium-123/chrome-win64/chrome.exe'), 'utf8'), 'fixture');
});

test('오래된 가드나 소스와 맞지 않는 가드 빌드 기록은 패키지에 넣지 않는다', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'guard-stage-'));
  const metadata = join(root, 'node_modules/playwright-core'); fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(join(metadata, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium', revision: '123' }] }));
  const source = join(root, '.tools/browser-runtime'); fs.mkdirSync(join(source,'chromium-123/chrome-win64'),{recursive:true}); fs.writeFileSync(join(source,'chromium-123/chrome-win64/chrome.exe'),'fixture');
  fs.mkdirSync(join(source,'guard')); fs.writeFileSync(join(source,'guard/BrowserGuard.exe'),'old guard');
  fs.mkdirSync(join(root,'backend/scripts'),{recursive:true}); fs.writeFileSync(join(root,'backend/scripts/BrowserGuard.cs'),'new source');
  const destination=join(root,'stage');
  assert.throws(() => stageBrowserRuntime(root,destination), /가드.*빌드|setup-browser/); assert.equal(fs.existsSync(destination),false);
  const digest=value=>createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(join(source,'guard/BrowserGuard.build.json'),JSON.stringify({schemaVersion:1,protocol:'browser-job-v2-witness-v1',sourceSha256:digest('old source'),binarySha256:digest('old guard')}));
  assert.throws(() => stageBrowserRuntime(root,destination), /가드.*빌드/); assert.equal(fs.existsSync(destination),false);
  fs.writeFileSync(join(source,'guard/BrowserGuard.build.json'),JSON.stringify({schemaVersion:1,protocol:'browser-job-v2-witness-v1',sourceSha256:digest('new source'),binarySha256:digest('different executable')}));
  assert.throws(() => stageBrowserRuntime(root,destination), /가드.*빌드/); assert.equal(fs.existsSync(destination),false);
});
