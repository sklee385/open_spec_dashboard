const { readFileSync, existsSync, cpSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
function stageBrowserRuntime(root, destination) {
  const metadata = JSON.parse(readFileSync(join(root, 'node_modules/playwright-core/browsers.json'), 'utf8'));
  const revision = metadata.browsers.find(browser => browser.name === 'chromium')?.revision;
  const source = join(root, '.tools/browser-runtime');
  if (!revision || !existsSync(join(source, `chromium-${revision}/chrome-win64/chrome.exe`))) throw new Error('전용 Chromium이 없습니다. scripts/setup-browser.ps1을 먼저 실행해 주세요');
  if (!existsSync(join(source, 'guard/BrowserGuard.exe'))) throw new Error('프로세스 소유권 가드가 없습니다. scripts/setup-browser.ps1을 실행해 주세요');
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true });
}
module.exports = { stageBrowserRuntime };
