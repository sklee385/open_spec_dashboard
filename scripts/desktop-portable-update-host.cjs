// Test-only Electron host. It never uses the user's installed app or profile.
const { app } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
app.disableHardwareAcceleration(); app.setPath('userData', config.userDirectory);
(async () => {
  const manifest = JSON.parse(fs.readFileSync(config.manifestPath, 'utf8'));
  const { preparePortableInstall } = require(path.join(config.source, 'resources/app.asar/desktop/portable-install.cjs'));
  const prepared = await preparePortableInstall({ archivePath: config.archive, expectedSha512: manifest.sha512, version: manifest.version,
    appDirectory: config.appDirectory, userDirectory: config.userDirectory, nodeBinary: path.join(config.source, 'resources/service/runtime/node.exe'),
    unzipper: require(path.join(config.source, 'resources/service/node_modules/unzipper')), smoke: true });
  fs.writeFileSync(config.resultPath, JSON.stringify({ configPath: prepared.configPath }));
  console.log('PORTABLE_ASAR_PREPARED');
  await prepared.launch(); app.exit(0);
})().catch(error => { console.error(error.stack); app.exit(1); });
