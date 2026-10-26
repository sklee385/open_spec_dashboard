const { EventEmitter } = require('node:events');
const { createHash, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const RELEASE_URL = 'https://api.github.com/repos/sklee385/open_spec_dashboard/releases/latest';
const DOWNLOAD_ROOT = 'https://github.com/sklee385/open_spec_dashboard/releases/download/';
const MAX_SIZE = 1536 * 1024 * 1024;
const RELEASE_JSON_LIMIT = 1024 * 1024;
const MANIFEST_JSON_LIMIT = 64 * 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TRUSTED_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function validatePortableManifest(value, version) {
  if (!value || !VERSION.test(version) || value.version !== version ||
      value.file !== `OpenSpecBoard-${version}-win-x64-portable.zip` ||
      !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_SIZE ||
      typeof value.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.sha512)) {
    throw new Error('Invalid portable update manifest.');
  }
  const digest = Buffer.from(value.sha512, 'base64');
  if (digest.length !== 64 || digest.toString('base64') !== value.sha512) throw new Error('Invalid portable update checksum.');
  return { version, file: value.file, size: value.size, sha512: value.sha512 };
}

function isNewer(target, current) {
  if (!VERSION.test(current)) throw new Error('Invalid current version.');
  const left = target.split('.').map(BigInt); const right = current.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return left[i] > right[i]; }
  return false;
}

async function readBoundedJson(response, signal, limit) {
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('Missing update metadata body.');
  const reader = response.body.getReader(); const bytes = Buffer.allocUnsafe(limit); let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value.byteLength > limit - length) throw new Error('Update metadata exceeds size limit.');
      bytes.set(value, length); length += value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

class PortableUpdater extends EventEmitter {
  constructor({ version, userDirectory, prepareInstall, exit, fetchImpl = globalThis.fetch }) {
    super();
    this.version = version; this.userDirectory = userDirectory; this.fetchImpl = fetchImpl;
    this.installPreparer = prepareInstall; this.exit = exit;
    this.verified = null; this.prepared = null; this.checking = false;
  }

  fail() {
    this.verified = null; this.prepared = null;
    const error = new Error('Portable update check, download or installation failed.');
    // EventEmitter throws unhandled error events; the operation still rejects safely without a subscriber.
    if (this.listenerCount('error')) this.emit('error', error);
    return error;
  }

  async request(url, consume) {
    const signal = AbortSignal.timeout(120_000);
    const response = await this.fetchImpl(url, { signal, headers: { Accept: 'application/vnd.github+json' } });
    if (!response?.ok) throw new Error('Update request failed.');
    if (response.redirected) {
      const location = new URL(response.url);
      if (location.protocol !== 'https:' || !TRUSTED_HOSTS.has(location.hostname) || location.username || location.password || location.port) throw new Error('Untrusted update response.');
    }
    return consume(response, signal);
  }

  async checkForUpdates() {
    if (this.checking) throw new Error('Portable update already in progress.');
    this.checking = true; this.verified = null; this.prepared = null;
    this.emit('checking-for-update');
    try {
      const release = await this.request(RELEASE_URL, (response, signal) => readBoundedJson(response, signal, RELEASE_JSON_LIMIT));
      if (!release || release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' ||
          !release.tag_name.startsWith('v') || !VERSION.test(release.tag_name.slice(1))) throw new Error('Invalid stable release.');
      const version = release.tag_name.slice(1);
      if (!isNewer(version, this.version)) { this.emit('update-not-available', { version }); this.checking = false; return { downloadPromise: Promise.resolve() }; }
      const base = `${DOWNLOAD_ROOT}v${version}/`;
      const manifest = validatePortableManifest(await this.request(base + 'portable.json', (response, signal) => readBoundedJson(response, signal, MANIFEST_JSON_LIMIT)), version);
      if (!Array.isArray(release.assets)) throw new Error('Missing release assets.');
      for (const name of ['portable.json', manifest.file]) {
        const matches = release.assets.filter(asset => asset?.name === name);
        if (matches.length !== 1 || matches[0].browser_download_url !== base + name ||
            (name === manifest.file && matches[0].size !== manifest.size)) throw new Error('Invalid release assets.');
      }
      this.emit('update-available', { version });
      const downloadPromise = this.download(base + manifest.file, manifest)
        .catch(() => { throw this.fail(); })
        .finally(() => { this.checking = false; });
      // A caller can attach the returned promise after checkForUpdates resolves without an unhandled rejection.
      void downloadPromise.catch(() => {});
      return { downloadPromise };
    } catch {
      this.checking = false; throw this.fail();
    }
  }

  async download(url, manifest) {
    const root = path.join(this.userDirectory, 'portable-updates');
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'download-'));
    const partialPath = path.join(directory, manifest.file + '.part');
    const archivePath = path.join(directory, manifest.file);
    try {
      const file = await fs.open(partialPath, 'wx');
      try {
        await this.request(url, async (response, signal) => {
          if (!response.body || typeof response.body.getReader !== 'function') throw new Error('Missing ZIP body.');
          const reader = response.body.getReader(); const hash = createHash('sha512'); let transferred = 0;
          const abort = () => { void reader.cancel().catch(() => {}); };
          signal.addEventListener('abort', abort, { once: true });
          try {
            for (;;) {
              signal.throwIfAborted();
              const { done, value } = await reader.read();
              signal.throwIfAborted();
              if (done) break;
              transferred += value.byteLength;
              if (transferred > manifest.size) throw new Error('ZIP exceeds expected size.');
              hash.update(value);
              // FileHandle.write may perform a partial write, so writeFile must finish each chunk.
              await file.writeFile(value);
              this.emit('download-progress', { total: manifest.size, transferred, percent: transferred / manifest.size * 100 });
            }
            if (transferred !== manifest.size || !timingSafeEqual(hash.digest(), Buffer.from(manifest.sha512, 'base64'))) throw new Error('ZIP validation failed.');
          } catch (error) { await reader.cancel().catch(() => {}); throw error; }
          finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
        });
        await file.sync();
      } finally { await file.close(); }
      await fs.rename(partialPath, archivePath);
      this.verified = { archivePath, expectedSha512: manifest.sha512, version: manifest.version };
      this.emit('update-downloaded', { version: manifest.version, downloadedFile: archivePath });
    } catch (error) {
      // directory comes only from our successful mkdtemp, never from release metadata.
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async prepareInstall() {
    if (!this.verified) throw new Error('Verified portable update required.');
    try {
      const prepared = await this.installPreparer({ ...this.verified });
      if (!prepared || typeof prepared.launch !== 'function') throw new Error('Invalid portable update handoff.');
      this.prepared = prepared;
    } catch { throw this.fail(); }
  }

  async quitAndInstall() {
    if (!this.verified || !this.prepared) throw new Error('Prepared portable update required.');
    const prepared = this.prepared; this.prepared = null;
    try { await prepared.launch(); await this.exit(); }
    catch { throw this.fail(); }
  }
}

module.exports = { PortableUpdater, validatePortableManifest };
