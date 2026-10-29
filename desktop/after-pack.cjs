const { existsSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
module.exports = async function afterPack(context) {
  const debugLog = join(context.appOutDir,'debug.log');
  if (existsSync(debugLog)) unlinkSync(debugLog);
  if (context.electronPlatformName !== 'win32') throw new Error('Windows 패키지만 지원합니다');
  const resources = join(context.appOutDir, 'resources');
  const service = join(resources, 'service');
  for (const name of ['emergency.cjs','emergency-process.ps1','emergency.ps1','emergency.cmd']) {
    if (!existsSync(join(resources, 'emergency', name))) throw new Error(`긴급 종료 리소스 누락: ${name}`);
  }
  if (!existsSync(join(context.appOutDir, 'OpenSpecBoard 긴급 종료.cmd'))) throw new Error('독립 긴급 종료 실행 도구 누락');
  const dependencies = Object.keys(require('../backend/package.json').dependencies).concat('electron-updater','unzipper');
  for (const name of dependencies) if (!existsSync(join(service, 'node_modules', name, 'package.json'))) throw new Error(`배포 의존성 누락: ${name}`);
  for (const name of ['backend/dist/desktop-main.js', 'frontend/index.html', 'runtime/node_modules/npm/bin/npm-cli.js', 'runtime/node.exe']) {
    if (!existsSync(join(service, name))) throw new Error(`배포 리소스 누락: ${name}`);
  }
};
