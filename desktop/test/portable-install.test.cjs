const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

function zipBuffer(files) {
  const bodies = []; const central = []; let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.from(value); const filename = Buffer.from(name);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(filename.length, 28); dir.writeUInt32LE(offset, 42);
    bodies.push(local, filename, data); central.push(dir, filename); offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, directory, end]);
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portable-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDirectory = path.join(root, 'app');
  const userDirectory = path.join(root, 'user');
  await fs.mkdir(appDirectory); await fs.mkdir(userDirectory);
  await fs.writeFile(path.join(appDirectory, 'old.txt'), 'old');
  const archivePath = path.join(root, 'release.zip');
  const files = {
    'OpenSpecBoard.exe': 'MZcandidate',
    'resources/service/build-info.json': JSON.stringify({ version: '1.2.3', platform: 'win32', arch: 'x64', updateMode: 'portable-github' }),
    'resources/service/runtime/node.exe': 'node',
    'resources/service/backend/dist/desktop-main.js': 'js',
    'resources/app.asar': 'asar',
  };
  const zip = zipBuffer(files); await fs.writeFile(archivePath, zip);
  const entries = () => Object.entries(files).map(([name, value]) => ({ path: name, type: 'File', uncompressedSize: Buffer.byteLength(value), externalFileAttributes: 0, stream: () => Readable.from([Buffer.from(value)]) }));
  return { root, files, entries, options: { archivePath, expectedSha512: crypto.createHash('sha512').update(zip).digest('base64'), version: '1.2.3', appDirectory, userDirectory, nodeBinary: process.execPath, unzipper: { Open: { file: async () => ({ files: entries() }) } } } };
}

test('preparation validates payload and leaves the live app and user data intact', async t => {
  const f = await fixture(t);
  const { preparePortableInstall } = require('../portable-install.cjs');
  const prepared = await preparePortableInstall(f.options);
  assert.match(prepared.jobId, /^[a-f0-9]{32}$/);
  assert.equal(await fs.readFile(path.join(f.options.appDirectory, 'old.txt'), 'utf8'), 'old');
  assert.equal(await fs.readFile(path.join(prepared.stageDirectory, 'OpenSpecBoard.exe'), 'utf8'), 'MZcandidate');
  assert.equal(typeof prepared.launch, 'function');
});

test('oversized build-info metadata is rejected before JSON materialization', async t => {
  const f=await fixture(t);const info=JSON.parse(f.files['resources/service/build-info.json']);
  f.files['resources/service/build-info.json']=JSON.stringify({...info,padding:'x'.repeat(65536)});
  await assert.rejects(require('../portable-install.cjs').preparePortableInstall(f.options),/metadata.*size/i);
});

for (const bad of ['../outside', '/absolute', 'C:/drive', 'resources\\bad', 'resources/CON.txt', 'resources/x.', 'resources/x ', 'resources/a:b', 'resources/\0bad']) {
  test(`rejects unsafe ZIP name ${JSON.stringify(bad)}`, async t => {
    const f = await fixture(t); f.files[bad] = 'bad';
    await assert.rejects(require('../portable-install.cjs').preparePortableInstall(f.options), /unsafe|invalid/i);
    assert.equal(await fs.readFile(path.join(f.options.appDirectory, 'old.txt'), 'utf8'), 'old');
  });
}
test('rejects duplicates, links, excessive sizes and truncated extraction', async t => {
  const f = await fixture(t); const { preparePortableInstall } = require('../portable-install.cjs');
  for (const mutate of [es => es.push({ ...es[0], path: 'openspecboard.EXE' }), es => { es[0].externalFileAttributes = (0o120777 << 16) >>> 0; }, es => { es[0].uncompressedSize = 2 ** 31 + 1; }, es => { es[0].uncompressedSize += 1; }]) {
    f.options.unzipper.Open.file = async () => { const files = f.entries(); mutate(files); return { files }; };
    await assert.rejects(preparePortableInstall(f.options));
  }
});
test('rejects SHA, version and user-directory overlap', async t => {
  const f = await fixture(t); const { preparePortableInstall } = require('../portable-install.cjs');
  await assert.rejects(preparePortableInstall({ ...f.options, expectedSha512: 'bad' }), /sha|digest/i);
  await assert.rejects(preparePortableInstall({ ...f.options, version: '9.0.0' }), /version/i);
  await assert.rejects(preparePortableInstall({ ...f.options, userDirectory: path.join(f.options.appDirectory, 'data') }), /overlap|scope/i);
});

test('swap preserves backup and rollback restores the existing application', async t => {
  const f = await fixture(t); const prepared = await require('../portable-install.cjs').preparePortableInstall(f.options);
  const { runSwap } = require('../portable-swap.cjs');
  const launches = [];
  const result = await runSwap(prepared.configPath, { parentExited: async () => true, relaunch: async exe => { launches.push(exe); return { pid: 1234 }; }, waitReady: async () => 'failed', retryDelayMs: 0 });
  assert.equal(result.status, 'manual-recovery-required');
  assert.equal(await fs.readFile(path.join(f.options.appDirectory, 'old.txt'), 'utf8'), 'old');
  assert.equal(launches.length, 1);
  assert.ok((await fs.readdir(f.root)).some(name => name.includes('failed')));
});
test('parent timeout never renames the live application', async t => {
  const f = await fixture(t); const prepared = await require('../portable-install.cjs').preparePortableInstall(f.options);
  const result = await require('../portable-swap.cjs').runSwap(prepared.configPath, { parentExited: async () => false, parentTimeoutMs: 0 });
  assert.equal(result.status, 'parent-timeout');
  assert.equal(await fs.readFile(path.join(f.options.appDirectory, 'old.txt'), 'utf8'), 'old');
});
test('ready report only accepts a matching known job and version', async t => {
  const f = await fixture(t); const prepared = await require('../portable-install.cjs').preparePortableInstall(f.options);
  const { reportPortableReady } = require('../portable-swap.cjs');
  const options = { argv: [`--portable-update-job=${prepared.jobId}`], ...f.options };
  assert.equal(await reportPortableReady({ ...options, version: 'wrong' }), false);
  assert.equal(await reportPortableReady(options), true);
  const marker = JSON.parse(await fs.readFile(path.join(path.dirname(prepared.configPath), 'ready.json')));
  assert.equal(marker.pid, process.pid);
});

test('real ZIP directory parsing and streamed extraction produce a complete candidate', async t => {
  const f = await fixture(t); const zip = zipBuffer(f.files);
  await fs.writeFile(f.options.archivePath, zip);
  const prepared = await require('../portable-install.cjs').preparePortableInstall({ ...f.options, expectedSha512: crypto.createHash('sha512').update(zip).digest('base64'), unzipper: require('unzipper') });
  assert.equal(await fs.readFile(path.join(prepared.stageDirectory, 'resources/app.asar'), 'utf8'), 'asar');
});
test('successful swap retains the entire old application backup', async t => {
  const f = await fixture(t); const prepared = await require('../portable-install.cjs').preparePortableInstall(f.options);
  const result = await require('../portable-swap.cjs').runSwap(prepared.configPath, { parentExited: async () => true, relaunch: async () => ({ pid: 123 }), waitReady: async () => 'ready' });
  assert.equal(result.status, 'complete');
  assert.equal(await fs.readFile(path.join(result.backupDirectory, 'old.txt'), 'utf8'), 'old');
  assert.equal(await fs.readFile(path.join(f.options.appDirectory, 'OpenSpecBoard.exe'), 'utf8'), 'MZcandidate');
});
test('stage rename failure restores old app and preserves candidate', async t => {
  const f = await fixture(t); const prepared = await require('../portable-install.cjs').preparePortableInstall(f.options);
  const result = await require('../portable-swap.cjs').runSwap(prepared.configPath, { parentExited: async () => true, rename: async (from, to) => { if (from === prepared.stageDirectory) throw new Error('injected rename failure'); await fs.rename(from, to); }, relaunch: async () => ({ pid: 123 }) });
  assert.equal(result.status, 'rolled-back');
  assert.equal(await fs.readFile(path.join(f.options.appDirectory, 'old.txt'), 'utf8'), 'old');
  assert.equal(await fs.readFile(path.join(prepared.stageDirectory, 'OpenSpecBoard.exe'), 'utf8'), 'MZcandidate');
});
test('uncertain candidate leaves both candidate and old backup intact', async t => {
  const f = await fixture(t); const prepared = await require('../portable-install.cjs').preparePortableInstall(f.options);
  const result = await require('../portable-swap.cjs').runSwap(prepared.configPath, { parentExited: async () => true, relaunch: async () => ({ pid: 123 }), waitReady: async () => 'uncertain' });
  assert.equal(result.status, 'uncertain');
  const config = JSON.parse(await fs.readFile(prepared.configPath));
  assert.equal(await fs.readFile(path.join(config.backupDirectory, 'old.txt'), 'utf8'), 'old');
});
test('linked jobs directory cannot write or delete data outside user scope', async t => {
  const f = await fixture(t); const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, path.join(f.options.userDirectory, 'portable-updates'), 'junction');
  await assert.rejects(require('../portable-install.cjs').preparePortableInstall(f.options), /scope|linked/i);
  assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
});
test('invalid user scope is rejected before creating data inside the live app', async t => {
  const f = await fixture(t);
  const userDirectory = path.join(f.options.appDirectory, 'must-not-create');
  await assert.rejects(require('../portable-install.cjs').preparePortableInstall({ ...f.options, userDirectory }), /overlap|scope/i);
  await assert.rejects(fs.stat(userDirectory), { code: 'ENOENT' });
});
test('candidate exit without proof of service stop is uncertain and never relaunches old app', async t => {
  const f = await fixture(t); const prepared = await require('../portable-install.cjs').preparePortableInstall(f.options); let launches = 0;
  const result = await require('../portable-swap.cjs').runSwap(prepared.configPath, { parentExited: async () => true, relaunch: async () => { launches++; return { pid: 123 }; }, waitReady: async () => 'exited' });
  assert.equal(result.status, 'uncertain'); assert.equal(launches, 1);
  assert.equal(await fs.readFile(path.join(f.options.appDirectory, 'OpenSpecBoard.exe'), 'utf8'), 'MZcandidate');
});
test('startup failure report is scoped to a known exact target and confirms stopped services', async t => {
  const f = await fixture(t); const prepared = await require('../portable-install.cjs').preparePortableInstall(f.options);
  const options = { argv: [`--portable-update-job=${prepared.jobId}`], ...f.options };
  const { reportPortableFailure } = require('../portable-swap.cjs');
  assert.equal(await reportPortableFailure({ ...options, version: 'wrong' }), false);
  assert.equal(await reportPortableFailure(options), true);
  const marker = JSON.parse(await fs.readFile(path.join(path.dirname(prepared.configPath), 'startup-failed.json')));
  assert.equal(marker.pid, process.pid); assert.equal(marker.serviceStopped, true); assert.equal(marker.appDirectory, f.options.appDirectory);
});
for (const serviceStopped of [false, true]) {
  test(`worker only restores a failed candidate with serviceStopped=${serviceStopped}`, async t => {
    const f = await fixture(t); const prepared = await require('../portable-install.cjs').preparePortableInstall(f.options); let launches = 0;
    const result = await require('../portable-swap.cjs').runSwap(prepared.configPath, {
      parentExited: async () => true,
      relaunch: async () => {
        launches++;
        await fs.writeFile(path.join(path.dirname(prepared.configPath), 'startup-failed.json'), JSON.stringify({ pid: 2147483647, version: '1.2.3', jobId: prepared.jobId, appDirectory: f.options.appDirectory, serviceStopped }));
        return { pid: 2147483647 };
      },
    });
    assert.equal(result.status, serviceStopped ? 'manual-recovery-required' : 'uncertain');
    assert.equal(launches, 1);
  });
}

function zip64Buffer(files, count = BigInt(Object.keys(files).length)) {
  const zip = zipBuffer(files); const end = Buffer.from(zip.subarray(-22)); const body = zip.subarray(0, -22);
  const record = Buffer.alloc(56); record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14); record.writeBigUInt64LE(count, 24); record.writeBigUInt64LE(count, 32); record.writeBigUInt64LE(BigInt(end.readUInt32LE(12)), 40); record.writeBigUInt64LE(BigInt(end.readUInt32LE(16)), 48);
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(body.length), 8); locator.writeUInt32LE(1, 16);
  end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([body, record, locator, end]);
}
test('ZIP64 normal payload is accepted by preflight and real unzipper', async t => {
  const f = await fixture(t); const zip = zip64Buffer(f.files); await fs.writeFile(f.options.archivePath, zip);
  const prepared = await require('../portable-install.cjs').preparePortableInstall({ ...f.options, expectedSha512: crypto.createHash('sha512').update(zip).digest('base64'), unzipper: require('unzipper') });
  assert.equal(await fs.readFile(path.join(prepared.stageDirectory, 'resources/app.asar'), 'utf8'), 'asar');
});
test('oversized or out-of-bounds ZIP metadata is rejected before calling unzipper', async t => {
  const f = await fixture(t); const { preparePortableInstall } = require('../portable-install.cjs'); let opened = false;
  const badSize = zipBuffer(f.files); badSize.writeUInt32LE(64 * 1024 * 1024 + 1, badSize.length - 10);
  const badOffset = zipBuffer(f.files); badOffset.writeUInt32LE(0xfffffffe, badOffset.length - 6);
  for (const zip of [zip64Buffer(f.files, 100001n), zip64Buffer(f.files, 2n ** 63n), badSize, badOffset]) {
    await fs.writeFile(f.options.archivePath, zip);
    await assert.rejects(preparePortableInstall({ ...f.options, expectedSha512: crypto.createHash('sha512').update(zip).digest('base64'), unzipper: { Open: { file: async () => { opened = true; return { files: f.entries() }; } } } }), /ZIP|metadata|directory/i);
    assert.equal(opened, false);
  }
});
test('ambiguous EOCD, ZIP comments and central records outside their declared range are rejected before unzipper', async t => {
  const f = await fixture(t); const { preparePortableInstall } = require('../portable-install.cjs');
  const duplicate = zipBuffer(f.files); duplicate.writeUInt32LE(0x06054b50, duplicate.length - 50);
  const comment = Buffer.concat([zipBuffer(f.files), Buffer.from('PK\x05\x06fake-comment')]); comment.writeUInt16LE(16, comment.length - 16 - 2);
  const badLength = zipBuffer(f.files); const centralOffset = badLength.readUInt32LE(badLength.length - 6); badLength.writeUInt16LE(65535, centralOffset + 28);
  const missingRecord = zipBuffer(f.files); missingRecord.writeUInt16LE(Object.keys(f.files).length - 1, missingRecord.length - 14); missingRecord.writeUInt16LE(Object.keys(f.files).length - 1, missingRecord.length - 12);
  for (const zip of [duplicate, comment, badLength, missingRecord]) {
    await fs.writeFile(f.options.archivePath, zip); let opened = false;
    await assert.rejects(preparePortableInstall({ ...f.options, expectedSha512: crypto.createHash('sha512').update(zip).digest('base64'), unzipper: { Open: { file: async () => { opened = true; return { files: f.entries() }; } } } }), /ZIP|directory|EOCD/i);
    assert.equal(opened, false);
  }
});
for (const smoke of [false, true]) {
  test(`smoke=${smoke} is explicitly scoped to the update candidate`, async t => {
    const f = await fixture(t); const prepared = await require('../portable-install.cjs').preparePortableInstall({ ...f.options, smoke });
    const config = JSON.parse(await fs.readFile(prepared.configPath)); assert.equal(config.smoke, smoke);
    let launch;
    await require('../portable-swap.cjs').runSwap(prepared.configPath, { parentExited: async () => true, relaunch: async (...args) => { launch = args; return { pid: 123 }; }, waitReady: async () => 'ready' });
    assert.equal(launch[1].includes('--desktop-smoke-test'), smoke);
    assert.equal(launch[3]?.DESKTOP_SMOKE_DIRECTORY, smoke ? f.options.userDirectory : undefined);
  });
}
test('invalid smoke config is rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(require('../portable-install.cjs').preparePortableInstall({ ...f.options, smoke: 'true' }), /smoke|job/i);
});
