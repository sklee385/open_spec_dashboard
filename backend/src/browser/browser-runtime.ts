import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function browserDirectory() {
  return resolve(process.env.OPENSPEC_BROWSER_DIRECTORY || join(__dirname, '../../../.tools/browser-runtime'));
}
export function browserRuntime(): typeof import('@playwright/test') {
  // Set before loading Playwright: it resolves its registry on first import.
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserDirectory();
  const api: typeof import('@playwright/test') = require('@playwright/test');
  if (!existsSync(api.chromium.executablePath())) throw new Error('브라우저 런타임이 없습니다. scripts/setup-browser.ps1을 실행해 주세요');
  return api;
}
