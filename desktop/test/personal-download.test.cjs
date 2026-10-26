const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { CancellationToken } = require('builder-util-runtime');
const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');
const { configureUpdateSelection } = require('../update-selection.cjs');
const { UpdateManager } = require('../updates.cjs');

test('실제 NSIS 다운로드는 미서명 파일을 해시 검사하고 변조 파일은 준비 상태로 넘기지 않는다', async t => {
  const original = Buffer.from('unsigned personal installer fixture; never executed');
  let payload = original;
  const server = http.createServer((_req, res) => { res.setHeader('Content-Length', payload.length); res.end(payload); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const tampered of [false, true]) {
    payload = tampered ? Buffer.from('tampered installer fixture; never executed') : original;
    const cache = fs.mkdtempSync(path.join(tmpdir(), 'personal-update-cache-'));
    const updater = new NsisUpdater(null, { version: '0.1.0', name: 'isolated-personal-test', baseCachePath: cache });
    updater.logger = null;
    updater.configOnDisk = { value: Promise.resolve({ updaterCacheDirName: 'updates' }) }; // No publisherName for the personal build.
    const executor = new ElectronHttpExecutor();
    // Keep the installed executor's download/hash pipeline; replace only Electron net transport with loopback Node HTTP.
    executor.createRequest = (options, callback) => http.request(options, callback);
    updater.httpExecutor = executor;
    updater.verifyUpdateCodeSignature = async () => { throw new Error('personal build must not request certificate verification'); };
    updater.doInstall = () => { throw new Error('fixture installer must never run'); };
    configureUpdateSelection(updater, { platform: 'win32', arch: 'x64' });
    const manager = new UpdateManager({ updater, enabled: true, version: '0.1.0', prepare: async () => {}, stop: async () => {}, cancel: async () => {} });
    const file = { url: 'OpenSpecBoard-0.2.0-win-x64.exe', sha512: createHash('sha512').update(original).digest('base64') };
    const info = { version: '0.2.0', tag: 'v0.2.0', files: [file] };
    assert.equal(await updater.isUpdateAvailable(info), true);
    const provider = { resolveFiles: () => [{ url: new URL(`http://127.0.0.1:${server.address().port}/${file.url}`), info: file }] };
    updater.updateInfoAndProvider = { info, provider };
    updater.disableDifferentialDownload = true; updater.disableWebInstaller = true;
    const download = updater.downloadUpdate(new CancellationToken());
    if (tampered) {
      await assert.rejects(download, error => error.code === 'ERR_CHECKSUM_MISMATCH');
      assert.equal(updater.installerPath, null);
      assert.equal(manager.snapshot().state, 'error');
      assert.equal(manager.downloaded, false);
    } else {
      const files = await download;
      assert.deepEqual(fs.readFileSync(files[0]), original);
      assert.equal(manager.snapshot().state, 'ready');
      assert.equal(updater.autoInstallOnAppQuit, false);
      assert.equal(updater.quitAndInstallCalled, false);
    }
  }
});
