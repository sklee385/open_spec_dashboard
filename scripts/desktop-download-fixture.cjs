// Local integration fixture only. Never bundled in the application or used to publish/install software.
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const { configureUpdateSelection } = require('../desktop/update-selection.cjs');
async function createDownloadFixture(profile) {
  const payload = Buffer.from('isolated unsigned update fixture; never execute');
  const filename = 'OpenSpecBoard-0.1.1-win-x64.exe';
  let mode = 'valid';
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/latest.yml')) {
      response.end(`version: 0.1.1\ntag: v0.1.1\nfiles:\n  - url: ${filename}\n    sha512: ${createHash('sha512').update(payload).digest('base64')}\n`); return;
    }
    if (request.url === '/' + filename) {
      if (mode === 'disconnect') { request.socket.destroy(); return; }
      response.end(mode === 'tampered' ? Buffer.from('changed update bytes') : payload); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const updater = new NsisUpdater(null, { version: '0.1.0', name: 'isolated-update-integration', isPackaged: true, userDataPath: profile, baseCachePath: path.join(profile, 'download-cache'), whenReady: async () => {} });
  updater.logger = null;
  updater.configOnDisk = { value: Promise.resolve({ updaterCacheDirName: 'updates' }) };
  const executor = new ElectronHttpExecutor();
  executor.createRequest = (options, callback) => http.request(options, callback);
  updater.httpExecutor = executor;
  updater.disableDifferentialDownload = true; updater.disableWebInstaller = true;
  updater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}/` });
  updater.doInstall = () => { throw new Error('fixture installer must never execute'); };
  configureUpdateSelection(updater, { platform: 'win32', arch: 'x64' });
  return { updater, setMode(value) { mode = value; }, close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}
module.exports = { createDownloadFixture };
