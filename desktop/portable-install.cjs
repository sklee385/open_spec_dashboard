'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { validateConfig } = require('./portable-swap.cjs');
const MAX_BYTES = 2 ** 31;
const MAX_ENTRIES = 100000;

async function preflightZip(archivePath) {
  const file = await fsp.open(archivePath, 'r');
  try {
    const size = (await file.stat()).size;
    if (!Number.isSafeInteger(size) || size < 22) throw new Error('Invalid ZIP metadata');
    async function read(position, length) {
      if (!Number.isSafeInteger(position) || position < 0 || position + length > size) throw new Error('ZIP metadata outside file bounds');
      const data = Buffer.alloc(length); const result = await file.read(data, 0, length, position);
      if (result.bytesRead !== length) throw new Error('Truncated ZIP metadata');
      return data;
    }
    // Match unzipper's first-signature search in its final 80 bytes exactly.
    const tailStart = Math.max(0, size - 80); const tail = await read(tailStart, size - tailStart);
    let signatures = 0;
    for (let i = 0; i <= tail.length - 4; i++) if (tail.readUInt32LE(i) === 0x06054b50) signatures++;
    const eocd = tail.subarray(tail.length - 22); const eocdOffset = size - 22;
    if (signatures !== 1 || eocd.readUInt32LE(0) !== 0x06054b50 || eocd.readUInt16LE(20) !== 0) throw new Error('Ambiguous EOCD or unsupported ZIP comment');
    if (eocd.readUInt16LE(4) || eocd.readUInt16LE(6)) throw new Error('Multi-disk ZIP is unsupported');
    let count = BigInt(eocd.readUInt16LE(10)); let diskCount = BigInt(eocd.readUInt16LE(8));
    let centralSize = BigInt(eocd.readUInt32LE(12)); let centralOffset = BigInt(eocd.readUInt32LE(16)); let boundary = BigInt(eocdOffset);
    const zip64 = count === 0xffffn || centralOffset === 0xffffffffn;
    if (!zip64 && (diskCount === 0xffffn || centralSize === 0xffffffffn)) throw new Error('Inconsistent ZIP64 directory sentinel');
    if (zip64) {
      const locator = await read(eocdOffset - 20, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw new Error('Invalid ZIP64 locator');
      const offset = locator.readBigUInt64LE(8);
      if (offset > BigInt(Number.MAX_SAFE_INTEGER) || offset + 56n > BigInt(eocdOffset - 20)) throw new Error('ZIP64 metadata outside file bounds');
      const record = await read(Number(offset), 56); const length = record.readBigUInt64LE(4);
      if (record.readUInt32LE(0) !== 0x06064b50 || length < 44n || length > 1024n * 1024n || offset + 12n + length !== BigInt(eocdOffset - 20) || record.readUInt32LE(16) || record.readUInt32LE(20)) throw new Error('Invalid ZIP64 directory metadata');
      diskCount = record.readBigUInt64LE(24); count = record.readBigUInt64LE(32); centralSize = record.readBigUInt64LE(40); centralOffset = record.readBigUInt64LE(48); boundary = offset;
    }
    if (count !== diskCount || count < 1n || count > BigInt(MAX_ENTRIES) || centralSize > 64n * 1024n * 1024n || centralSize < count * 46n || centralOffset + centralSize > boundary) throw new Error('ZIP directory metadata exceeds limits or file bounds');
    const directoryStart = Number(centralOffset); const directoryEnd = Number(centralOffset + centralSize);
    let cursor = directoryStart; let totalBytes = 0n;
    for (let i = 0; i < Number(count); i++) {
      if (cursor + 46 > directoryEnd) throw new Error('ZIP central entry exceeds declared directory size');
      const header = await read(cursor, 46);
      if (header.readUInt32LE(0) !== 0x02014b50 || header.readUInt16LE(34) !== 0) throw new Error('Invalid ZIP central entry');
      const nameLength = header.readUInt16LE(28); const extraLength = header.readUInt16LE(30); const commentLength = header.readUInt16LE(32);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (!nameLength || next > directoryEnd) throw new Error('ZIP central entry exceeds declared directory size');
      const fields = [header.readUInt32LE(24), header.readUInt32LE(20), header.readUInt32LE(42)].map(BigInt);
      const extra = await read(cursor + 46 + nameLength, extraLength); let field = null;
      for (let offset = 0; offset < extra.length;) {
        if (offset + 4 > extra.length) throw new Error('Invalid ZIP extra metadata');
        const length = extra.readUInt16LE(offset + 2); const end = offset + 4 + length;
        if (end > extra.length) throw new Error('Invalid ZIP extra metadata bounds');
        if (extra.readUInt16LE(offset) === 1 && field === null) field = extra.subarray(offset + 4, end);
        offset = end;
      }
      let fieldOffset = 0;
      for (let j = 0; j < fields.length; j++) if (fields[j] === 0xffffffffn) {
        if (!field || fieldOffset + 8 > field.length) throw new Error('Missing ZIP64 entry metadata');
        fields[j] = field.readBigUInt64LE(fieldOffset); fieldOffset += 8;
      }
      const [uncompressed, compressed, localOffset] = fields;
      totalBytes += uncompressed;
      if (totalBytes > BigInt(MAX_BYTES) || compressed > BigInt(MAX_BYTES) || localOffset + 30n > centralOffset) throw new Error('ZIP entry size or offset exceeds bounds');
      const local = await read(Number(localOffset), 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || localOffset + 30n + BigInt(local.readUInt16LE(26) + local.readUInt16LE(28)) + compressed > centralOffset) throw new Error('ZIP local entry exceeds payload bounds');
      cursor = next;
    }
    if (cursor !== directoryEnd) throw new Error('ZIP directory count and declared size disagree');
  } finally { await file.close(); }
}

async function safeDirectory(directory) {
  try { await fsp.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fsp.realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error('Unsafe linked job scope');
}

function safeEntry(entry) {
  const name = entry.path;
  if (typeof name !== 'string' || !name || /[\\\0:]/.test(name) || name.startsWith('/')) throw new Error('Unsafe ZIP path');
  const directory = entry.type === 'Directory';
  const parts = (directory && name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /[<>"|?*\x00-\x1f]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe ZIP path');
  const unixType = ((entry.externalFileAttributes >>> 16) & 0o170000);
  if ((!directory && entry.type !== 'File') || (unixType && unixType !== (directory ? 0o040000 : 0o100000))) throw new Error('Unsafe ZIP file type');
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || (directory && entry.uncompressedSize !== 0)) throw new Error('Invalid ZIP size');
  return { entry, name: parts.join('/'), directory };
}

async function preparePortableInstall({ archivePath, expectedSha512, version, appDirectory, userDirectory, nodeBinary, parentPid = process.pid, executableName = 'OpenSpecBoard.exe', unzipper = require('unzipper'), smoke = false }) {
  if (typeof smoke !== 'boolean') throw new Error('Invalid smoke option');
  if (typeof version !== 'string' || !version || executableName !== 'OpenSpecBoard.exe') throw new Error('Invalid target version or executable');
  for (const location of [archivePath, appDirectory, userDirectory, nodeBinary]) if (!path.isAbsolute(location)) throw new Error('Invalid absolute scope');
  appDirectory = await fsp.realpath(appDirectory);
  const relativeUser = path.relative(appDirectory, path.resolve(userDirectory));
  if (!relativeUser || (relativeUser !== '..' && !relativeUser.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeUser))) throw new Error('Portable directory overlap');
  await fsp.mkdir(userDirectory, { recursive: true });
  userDirectory = await fsp.realpath(userDirectory);
  const jobId = crypto.randomBytes(16).toString('hex');
  const parent = path.dirname(appDirectory);
  const prefix = `.${path.basename(appDirectory)}-update-`;
  const config = { jobId, version, appDirectory, userDirectory, parentPid, executableName, smoke, stageDirectory: path.join(parent, `${prefix}pending`), backupDirectory: path.join(parent, `.${path.basename(appDirectory)}-backup-${jobId}`), failedDirectory: path.join(parent, `.${path.basename(appDirectory)}-failed-${jobId}`) };
  validateConfig(config, path.join(userDirectory, 'portable-updates', 'jobs', jobId, 'config.json'));
  const digest = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(archivePath)) digest.update(chunk);
  const actual = digest.digest('base64');
  if (actual !== expectedSha512) throw new Error('Archive SHA512 digest mismatch');
  await preflightZip(archivePath);
  const zip = await unzipper.Open.file(archivePath);
  if (!Array.isArray(zip.files) || !zip.files.length || zip.files.length > MAX_ENTRIES) throw new Error('Invalid ZIP entry count');
  const entries = zip.files.map(safeEntry);
  const names = new Map(); let total = 0;
  for (const item of entries) {
    const key = item.name.toLowerCase();
    if (names.has(key)) throw new Error('Duplicate ZIP path');
    names.set(key, item.directory); total += item.entry.uncompressedSize;
    if (!Number.isSafeInteger(total) || total > MAX_BYTES) throw new Error('ZIP exceeds size limit');
  }
  for (const item of entries) {
    const parts = item.name.toLowerCase().split('/'); parts.pop();
    while (parts.length) { if (names.get(parts.join('/')) === false) throw new Error('Invalid ZIP file ancestor'); parts.pop(); }
  }
  let stageDirectory; let jobDirectory;
  try {
    stageDirectory = await fsp.mkdtemp(path.join(parent, prefix));
    config.stageDirectory = stageDirectory;
    let actualTotal = 0;
    for (const { entry, name, directory } of entries) {
      const target = path.join(stageDirectory, ...name.split('/'));
      if (directory) { await fsp.mkdir(target, { recursive: true }); continue; }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      let bytes = 0;
      await pipeline(entry.stream(), new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; actualTotal += chunk.length; if (bytes > entry.uncompressedSize || actualTotal > MAX_BYTES) callback(new Error('ZIP decompressed size exceeded')); else callback(null, chunk); } }), fs.createWriteStream(target, { flags: 'wx' }));
      if (bytes !== entry.uncompressedSize) throw new Error('ZIP decompressed size mismatch');
    }
    const executable = await fsp.open(path.join(stageDirectory, executableName));
    try { const bytes = Buffer.alloc(2); await executable.read(bytes, 0, 2, 0); if (bytes.toString() !== 'MZ') throw new Error('Invalid executable signature'); } finally { await executable.close(); }
    const infoPath = path.join(stageDirectory, 'resources/service/build-info.json');
    const infoStat = await fsp.stat(infoPath);
    if (!infoStat.isFile() || infoStat.size > 65536) throw new Error('Build metadata exceeds size limit');
    const infoHandle = await fsp.open(infoPath);
    let info;
    try {
      const buffer = Buffer.alloc(65537); let length = 0;
      while (length < buffer.length) { const { bytesRead } = await infoHandle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
      if (length > 65536) throw new Error('Build metadata exceeds size limit');
      info = JSON.parse(buffer.subarray(0,length).toString('utf8'));
    } finally { await infoHandle.close(); }
    if (info.version !== version || info.platform !== 'win32' || info.arch !== 'x64' || info.updateMode !== 'portable-github') throw new Error('Payload version or build metadata mismatch');
    for (const name of ['resources/service/runtime/node.exe', 'resources/service/backend/dist/desktop-main.js', 'resources/app.asar']) if (!(await fsp.stat(path.join(stageDirectory, name))).isFile()) throw new Error('Invalid required payload file');
    const updatesDirectory = path.join(userDirectory, 'portable-updates');
    await safeDirectory(updatesDirectory);
    const jobsDirectory = path.join(updatesDirectory, 'jobs');
    await safeDirectory(jobsDirectory);
    jobDirectory = path.join(jobsDirectory, jobId);
    await fsp.mkdir(jobDirectory);
    await fsp.copyFile(nodeBinary, path.join(jobDirectory, 'node.exe'), fs.constants.COPYFILE_EXCL);
    await fsp.copyFile(path.join(__dirname, 'portable-swap.cjs'), path.join(jobDirectory, 'portable-swap.cjs'), fs.constants.COPYFILE_EXCL);
    const configPath = path.join(jobDirectory, 'config.json');
    await fsp.writeFile(configPath, JSON.stringify(config), { flag: 'wx' });
    let launched = false;
    return { jobId, configPath, stageDirectory, launch: async () => {
      if (launched) throw new Error('Portable helper already launched');
      launched = true;
      return new Promise((resolve, reject) => {
        const child = spawn(path.join(jobDirectory, 'node.exe'), [path.join(jobDirectory, 'portable-swap.cjs'), configPath], { cwd: jobDirectory, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        let settled = false;
        const timer = setTimeout(() => finish(new Error('Portable helper readiness timeout')), 15000);
        function finish(error) { if (settled) return; settled = true; clearTimeout(timer); child.removeAllListeners('message'); child.removeAllListeners('exit'); if (error) child.kill(); if (child.connected) child.disconnect(); child.unref(); error ? reject(error) : resolve(); }
        child.once('error', finish);
        child.once('exit', () => finish(new Error('Portable helper exited before ready')));
        child.on('message', message => { if (message?.type === 'ready' && message.jobId === jobId) finish(); else if (message?.type === 'error') finish(new Error(message.message)); });
      });
    } };
  } catch (error) {
    // Only the fresh extraction directory is owned and disposable. Job diagnostics remain.
    if (stageDirectory) await fsp.rm(stageDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
module.exports = { preparePortableInstall };
