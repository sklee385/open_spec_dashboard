const { validateStageName } = require('./stage-directory.cjs');
const stage = `.tools/${validateStageName(process.env.DESKTOP_STAGE_NAME ?? 'desktop-stage')}`;
module.exports = {
  appId: 'io.github.sklee385.openspecboard', productName: 'OpenSpecBoard', electronVersion: '45.0.0',
  electronDist: 'node_modules/electron/dist',
  directories: { app: stage, output: '.tools/desktop-dist' },
  files: ['desktop/**/*', 'package.json', '!node_modules/**/*'],
  extraResources: [
    { from: 'desktop', to: 'emergency', filter: ['emergency.cjs','emergency-process.ps1','emergency.ps1','emergency.cmd'] },
    { from: `${stage}/service`, to: 'service', filter: ['**/*'] },
    // electron-builder filters node_modules at each source root; copy this graph explicitly.
    { from: `${stage}/service/node_modules`, to: 'service/node_modules', filter: ['**/*'] },
  ],
  afterPack: require('./after-pack.cjs'),
  asar: true, npmRebuild: false,
  extraFiles: [{ from: 'desktop/recovery-launch.cmd', to: 'OpenSpecBoard 긴급 종료.cmd' }, ...(process.env.DESKTOP_PORTABLE_BUILD === '1' ? [{ from: 'docs/PORTABLE.md', to: '무설치 실행 안내.txt' }] : [])],
  protocols: [{ name: 'OpenSpecBoard attention', schemes: ['openspecboard'] }],
  artifactName: 'OpenSpecBoard-${version}-${os}-${arch}.${ext}',
  publish: { provider: 'github', owner: 'sklee385', repo: 'open_spec_dashboard', releaseType: 'draft' },
  win: { icon: 'desktop/assets/openspecboard.ico', target: [{ target: 'nsis', arch: ['x64'] }], forceCodeSigning: false, verifyUpdateCodeSignature: false },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
};
