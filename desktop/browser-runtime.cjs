const { createHash } = require('node:crypto');
const { readFileSync, existsSync, cpSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
function stageBrowserRuntime(root, destination) {
  const metadata = JSON.parse(readFileSync(join(root, 'node_modules/playwright-core/browsers.json'), 'utf8'));
  const revision = metadata.browsers.find(browser => browser.name === 'chromium')?.revision;
  const source = join(root, '.tools/browser-runtime');
  if (!revision || !existsSync(join(source, `chromium-${revision}/chrome-win64/chrome.exe`))) throw new Error('전용 Chromium이 없습니다. scripts/setup-browser.ps1을 먼저 실행해 주세요');
  if (!existsSync(join(source, 'guard/BrowserGuard.exe'))) throw new Error('프로세스 소유권 가드가 없습니다. scripts/setup-browser.ps1을 실행해 주세요');
  const guard = join(source, 'guard/BrowserGuard.exe'), receipt = join(source, 'guard/BrowserGuard.build.json');
  try {
    const build = JSON.parse(readFileSync(receipt, 'utf8'));
    const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
    if (build.schemaVersion !== 1 || build.protocol !== 'browser-job-v2-witness-v1' || build.sourceSha256 !== digest(join(root, 'backend/scripts/BrowserGuard.cs')) || build.binarySha256 !== digest(guard)) throw new Error('mismatch');
  } catch { throw new Error('가드 빌드 기록이 없거나 현재 소스·실행 파일과 다릅니다. scripts/setup-browser.ps1로 다시 준비해 주세요'); }
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true });
}
module.exports = { stageBrowserRuntime };
