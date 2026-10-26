const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PortableUpdater, validatePortableManifest } = require('../portable-updater.cjs');

const BASE = 'https://github.com/sklee385/open_spec_dashboard/releases/download/v1.2.3/';
const DATA = Buffer.from('portable ZIP bytes');
const digest = bytes => createHash('sha512').update(bytes).digest('base64');
function metadata() {
  const manifest = { version: '1.2.3', file: 'OpenSpecBoard-1.2.3-win-x64-portable.zip', size: DATA.length, sha512: digest(DATA) };
  const release = { tag_name: 'v1.2.3', draft: false, prerelease: false, assets: [
    { name: 'portable.json', browser_download_url: BASE + 'portable.json' },
    { name: manifest.file, browser_download_url: BASE + manifest.file, size: manifest.size },
  ] };
  return { manifest, release };
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-updater-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const meta = metadata(); const requests = []; const events = []; let exited = 0;
  const updater = new PortableUpdater({ version: '1.0.0', userDirectory: directory,
    prepareInstall: async () => ({ launch: async () => {} }), exit: () => { exited++; },
    fetchImpl: async (url, init) => {
      requests.push(url); assert.ok(init.signal instanceof AbortSignal);
      if (options.fetch) return options.fetch(url, init, meta);
      if (url.endsWith('/latest')) return Response.json(meta.release);
      if (url.endsWith('/portable.json')) return Response.json(meta.manifest);
      return new Response(options.bytes || DATA);
    }, ...options.constructor });
  for (const name of ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'error']) updater.on(name, value => events.push([name, value]));
  return { updater, meta, requests, events, directory, exited: () => exited };
}
async function download(updater) { const result = await updater.checkForUpdates(); await result?.downloadPromise; }

test('downloads fixed ZIP URL, verifies bytes, reports progress and prepares portable handoff', async t => {
  let prepared; let launched = false;
  const f = await fixture(t, { constructor: { prepareInstall: async args => { prepared = args; return { launch: async () => { launched = true; } }; } } });
  await assert.rejects(f.updater.quitAndInstall());
  await download(f.updater);
  assert.deepEqual(f.requests, ['https://api.github.com/repos/sklee385/open_spec_dashboard/releases/latest', BASE + 'portable.json', BASE + f.meta.manifest.file]);
  assert.equal(f.events.filter(([name]) => name === 'update-downloaded').length, 1);
  assert.equal(f.events.findLast(([name]) => name === 'download-progress')[1].percent, 100);
  await assert.rejects(f.updater.quitAndInstall());
  await f.updater.prepareInstall();
  assert.equal(prepared.expectedSha512, digest(DATA));
  assert.equal(prepared.version, '1.2.3');
  assert.deepEqual(await fs.readFile(prepared.archivePath), DATA);
  assert.ok(prepared.archivePath.startsWith(path.join(f.directory, 'portable-updates', 'download-')));
  await f.updater.quitAndInstall(); assert.equal(launched, true); assert.equal(f.exited(), 1);
});

for (const version of ['1.2.3', '2.0.0', '99999999999999999999999999999.0.0']) test(`does not downgrade ${version}`, async t => {
  const f = await fixture(t, { constructor: { version } }); await download(f.updater);
  assert.equal(f.requests.length, 1); assert.ok(f.events.some(([name]) => name === 'update-not-available'));
});

for (const change of [r => { r.prerelease = true; }, r => { r.draft = true; }, r => { r.tag_name = 'v1.2.3-beta'; }, r => { r.tag_name = 'v01.2.3'; }, r => { delete r.prerelease; }]) test('refuses nonstable release metadata', async t => {
  const f = await fixture(t); change(f.meta.release);
  await assert.rejects(download(f.updater)); assert.equal(f.requests.length, 1); await assert.rejects(f.updater.prepareInstall());
});

for (const change of [
  m => { m.file = 'installer.exe'; }, m => { m.version = '1.2.4'; }, m => { m.size = 0; },
  m => { m.size = 1610612737; }, m => { m.sha512 = 'garbage'; }, m => { m.sha512 = m.sha512.replace(/=$/, ''); },
]) test('manifest rejects unsafe metadata', () => {
  const { manifest } = metadata(); change(manifest); assert.throws(() => validatePortableManifest(manifest, '1.2.3'));
});

for (const change of [
  r => { r.assets.push(r.assets[1]); }, r => { r.assets.splice(0, 1); },
  r => { r.assets[1].browser_download_url = 'https://evil.example/file.zip'; },
  r => { r.assets[1].size++; }, r => { r.assets[0].browser_download_url += '?token=secret'; },
]) test('rejects missing, duplicate or mismatched GitHub assets', async t => {
  const f = await fixture(t); change(f.meta.release); await assert.rejects(download(f.updater));
  assert.equal(f.requests.length, 2); assert.ok(f.events.some(([name]) => name === 'error'));
});

for (const bytes of [Buffer.from('tampered ZIP bytes'), DATA.subarray(1), Buffer.concat([DATA, DATA])]) test('rejects corrupt download and removes own partial download', async t => {
  const f = await fixture(t, { bytes }); await assert.rejects(download(f.updater));
  assert.ok(!f.events.some(([name]) => name === 'update-downloaded')); await assert.rejects(f.updater.prepareInstall());
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'portable-updates')), []);
});

test('sanitizes fetch failures and supports subsequent retry', async t => {
  let failed = false;
  const f = await fixture(t, { fetch: async (url, init, meta) => {
    if (!failed) { failed = true; throw new Error('https://secret.example/token?secret=private'); }
    return url.endsWith('/latest') ? Response.json(meta.release) : url.endsWith('/portable.json') ? Response.json(meta.manifest) : new Response(DATA);
  } });
  await assert.rejects(download(f.updater), error => !error.message.includes('secret'));
  await download(f.updater); assert.ok(f.events.some(([name]) => name === 'update-downloaded'));
});

test('rejects redirected responses outside trusted asset hosts', async t => {
  const f = await fixture(t, { fetch: async () => ({ ok: true, redirected: true, url: 'https://evil.example/private', json: async () => metadata().release }) });
  await assert.rejects(download(f.updater));
});

test('handoff failure never exits and disables prepared installation', async t => {
  const f = await fixture(t, { constructor: { prepareInstall: async () => ({ launch: async () => { throw new Error('handoff failed'); } }) } });
  await download(f.updater); await f.updater.prepareInstall(); await assert.rejects(f.updater.quitAndInstall());
  assert.equal(f.exited(), 0); await assert.rejects(f.updater.quitAndInstall());
});

test('streams multiple chunks through trusted GitHub asset redirects', async t => {
  const f = await fixture(t, { fetch: async (url, init, meta) => {
    if (url.endsWith('/latest')) return Response.json(meta.release);
    if (url.endsWith('/portable.json')) return Response.json(meta.manifest);
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(DATA.subarray(0, 4)); controller.enqueue(DATA.subarray(4)); controller.close();
    } }));
    Object.defineProperties(response, { redirected: { value: true }, url: { value: 'https://release-assets.githubusercontent.com/asset?token=temporary' } });
    return response;
  } });
  await download(f.updater);
  const progress = f.events.filter(([name]) => name === 'download-progress').map(([, value]) => value.transferred);
  assert.deepEqual(progress, [4, DATA.length]);
});

test('stream errors remove incomplete files and permit a fresh check', async t => {
  let failed = false;
  const f = await fixture(t, { fetch: async (url, init, meta) => {
    if (url.endsWith('/latest')) return Response.json(meta.release);
    if (url.endsWith('/portable.json')) return Response.json(meta.manifest);
    if (failed) return new Response(DATA);
    failed = true;
    return new Response(new ReadableStream({ pull(controller) { controller.error(new Error('secret transport details')); } }));
  } });
  await assert.rejects(download(f.updater), error => !error.message.includes('secret'));
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'portable-updates')), []);
  await download(f.updater); assert.ok(f.events.some(([name]) => name === 'update-downloaded'));
});

test('failed installation preparation invalidates update and never exits', async t => {
  const f = await fixture(t, { constructor: { prepareInstall: async () => { throw new Error('private preparation failure'); } } });
  await download(f.updater);
  await assert.rejects(f.updater.prepareInstall(), error => !error.message.includes('private'));
  await assert.rejects(f.updater.quitAndInstall()); assert.equal(f.exited(), 0);
});

for (const [endpoint, limit, requestCount] of [['/latest', 1024 * 1024, 1], ['/portable.json', 64 * 1024, 2]]) {
  test(`rejects oversized ${endpoint} JSON before downloading ZIP and permits retry`, async t => {
    let oversized = true; let cancelled = false;
    const f = await fixture(t, { fetch: async (url, init, meta) => {
      if (oversized && url.endsWith(endpoint)) {
        const json = Buffer.from(JSON.stringify(endpoint === '/latest' ? meta.release : meta.manifest));
        const bytes = Buffer.concat([json, Buffer.alloc(limit + 3 * 8192 - json.length, 0x20)]);
        let offset = 0;
        return new Response(new ReadableStream({
          pull(controller) {
            if (offset === bytes.length) { controller.close(); return; }
            const next = Math.min(offset + 8192, bytes.length);
            controller.enqueue(bytes.subarray(offset, next)); offset = next;
          },
          cancel() { cancelled = true; },
        }));
      }
      return url.endsWith('/latest') ? Response.json(meta.release) : url.endsWith('/portable.json') ? Response.json(meta.manifest) : new Response(DATA);
    } });
    await assert.rejects(download(f.updater));
    assert.equal(f.requests.length, requestCount); assert.equal(cancelled, true);
    assert.ok(!f.requests.some(url => url.endsWith('.zip')));
    await assert.rejects(f.updater.prepareInstall());
    oversized = false; await download(f.updater);
    assert.ok(f.events.some(([name]) => name === 'update-downloaded'));
  });
}

test('aborting metadata reading cancels its stream and rejects without ZIP download', async t => {
  const controller = new AbortController(); let cancelled = false;
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const f = await fixture(t, { fetch: async () => new Response(new ReadableStream({
    pull() { setImmediate(() => controller.abort()); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(download(f.updater));
  assert.equal(cancelled, true); assert.equal(f.requests.length, 1);
});
