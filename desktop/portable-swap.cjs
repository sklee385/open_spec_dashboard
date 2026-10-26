'use strict';
// This file is copied beside a private Node runtime; keep it standard-library only.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const contains = (a, b) => { const relative = path.relative(a, b); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };

function validateConfig(c, configPath) {
  if (typeof c?.smoke !== 'boolean') throw new Error('Invalid portable smoke configuration');
  if (!c || !/^[a-f0-9]{32}$/.test(c.jobId) || typeof c.version !== 'string' || !c.version || !Number.isSafeInteger(c.parentPid) || c.parentPid <= 0 || c.executableName !== 'OpenSpecBoard.exe') throw new Error('Invalid portable job');
  for (const p of [c.appDirectory, c.userDirectory, c.stageDirectory, c.backupDirectory, c.failedDirectory, configPath]) if (typeof p !== 'string' || !path.isAbsolute(p) || path.resolve(p) !== p) throw new Error('Invalid absolute scope');
  const parent = path.dirname(c.appDirectory); const base = path.basename(c.appDirectory);
  if (same(parent, c.appDirectory) || contains(c.appDirectory, c.userDirectory) || contains(c.userDirectory, c.appDirectory)) throw new Error('Portable directory overlap');
  if (!same(configPath, path.join(c.userDirectory, 'portable-updates/jobs', c.jobId, 'config.json'))) throw new Error('Invalid job scope');
  if (!same(parent, path.dirname(c.stageDirectory)) || !path.basename(c.stageDirectory).startsWith(`.${base}-update-`)) throw new Error('Invalid stage scope');
  if (!same(c.backupDirectory, path.join(parent, `.${base}-backup-${c.jobId}`)) || !same(c.failedDirectory, path.join(parent, `.${base}-failed-${c.jobId}`))) throw new Error('Invalid backup scope');
  for (const p of [c.stageDirectory, c.backupDirectory, c.failedDirectory]) if (contains(p, c.userDirectory) || contains(c.userDirectory, p) || same(p, c.appDirectory)) throw new Error('Portable path overlap');
  return c;
}
async function readConfig(configPath) {
  const c = validateConfig(JSON.parse(await fs.readFile(configPath, 'utf8')), configPath);
  for (const p of [c.appDirectory, c.userDirectory, path.dirname(c.appDirectory), path.dirname(configPath), c.stageDirectory]) {
    const stat = await fs.lstat(p);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(await fs.realpath(p), p)) throw new Error('Unsafe linked portable scope');
  }
  return c;
}
async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value)); }
function exited(pid) { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }
async function renameRetry(from, to, options) {
  for (let attempt = 0; ; attempt++) {
    try { await (options.rename || fs.rename)(from, to); return; } catch (e) { if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(e.code) || attempt >= 39) throw e; await delay(options.retryDelayMs ?? 250); }
  }
}
function relaunch(executable, argv, cwd, env = process.env) {
  return new Promise((resolve, reject) => { const child = spawn(executable, argv, { cwd, env, detached: true, windowsHide: false, stdio: 'ignore' }); child.once('error', reject); child.once('spawn', () => { child.unref(); resolve({ pid: child.pid }); }); });
}
async function waitReady(c, jobDirectory, pid, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const ready = JSON.parse(await fs.readFile(path.join(jobDirectory, 'ready.json'), 'utf8')); if (ready.jobId === c.jobId && ready.version === c.version && ready.pid === pid) return 'ready'; } catch {}
    if (exited(pid)) {
      try {
        const failed = JSON.parse(await fs.readFile(path.join(jobDirectory, 'startup-failed.json'), 'utf8'));
        if (failed.jobId === c.jobId && failed.version === c.version && failed.pid === pid && failed.serviceStopped === true && same(failed.appDirectory, c.appDirectory)) return 'failed';
      } catch {}
      return 'exited';
    }
    await delay(250);
  }
  return 'uncertain';
}
async function runSwap(configPath, options = {}) {
  const c = await readConfig(configPath); const jobDirectory = path.dirname(configPath);
  const journal = async (status, details = {}) => { const state = { status, ...details, time: new Date().toISOString(), jobId: c.jobId }; await writeJson(path.join(jobDirectory, 'journal.json'), state); return state; };
  await journal('waiting-parent');
  const start = Date.now();
  while (!await (options.parentExited || exited)(c.parentPid)) {
    if (Date.now() - start >= (options.parentTimeoutMs ?? 120000)) return journal('parent-timeout');
    await delay(250);
  }
  for (const p of [c.backupDirectory, c.failedDirectory]) { try { await fs.lstat(p); throw new Error('Backup destination already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  await journal('swapping');
  await renameRetry(c.appDirectory, c.backupDirectory, options);
  let installed = false;
  const restore = async (reason, restartOld = true) => {
    try {
      if (installed) await renameRetry(c.appDirectory, c.failedDirectory, options);
      await renameRetry(c.backupDirectory, c.appDirectory, options);
      const details = { reason, userDirectory: c.userDirectory, backupDirectory: c.backupDirectory, failedDirectory: c.failedDirectory };
      await journal(restartOld ? 'rolled-back' : 'manual-recovery-required', details);
      if (restartOld) await (options.relaunch || relaunch)(path.join(c.appDirectory, c.executableName), [], c.appDirectory);
      return journal(restartOld ? 'rolled-back' : 'manual-recovery-required', details);
    } catch (error) { return journal('rollback-failed', { reason, error: error.message }); }
  };
  try { await renameRetry(c.stageDirectory, c.appDirectory, options); installed = true; } catch (error) { return restore(error.message); }
  let child;
  const candidateArgs = [`--portable-update-job=${c.jobId}`, ...(c.smoke ? ['--desktop-smoke-test'] : [])];
  const candidateEnv = c.smoke ? { ...process.env, DESKTOP_SMOKE_DIRECTORY: c.userDirectory } : undefined;
  try { child = await (options.relaunch || relaunch)(path.join(c.appDirectory, c.executableName), candidateArgs, c.appDirectory, candidateEnv); } catch (error) { return restore(error.message); }
  await journal('waiting-ready', { pid: child.pid });
  const result = await (options.waitReady || waitReady)(c, jobDirectory, child.pid);
  if (result === 'ready') return journal('complete', { pid: child.pid, backupDirectory: c.backupDirectory });
  if (result === 'failed') return restore('Candidate confirmed services stopped after startup failure; data compatibility requires manual recovery', false);
  return journal('uncertain', { pid: child.pid });
}
function isPortableUpdateLaunch(argv) { return Array.isArray(argv) && argv.some(a => /^--portable-update-job=[a-f0-9]{32}$/.test(a)); }
async function reportMarker({ argv, userDirectory, appDirectory, version }, failure) {
  try {
    const args = argv.filter(a => typeof a === 'string' && a.startsWith('--portable-update-job='));
    if (args.length !== 1 || !isPortableUpdateLaunch(args) || !path.isAbsolute(userDirectory) || !path.isAbsolute(appDirectory)) return false;
    const jobId = args[0].slice('--portable-update-job='.length);
    const configPath = path.join(userDirectory, 'portable-updates/jobs', jobId, 'config.json');
    const c = validateConfig(JSON.parse(await fs.readFile(configPath, 'utf8')), configPath);
    if (!same(c.appDirectory, appDirectory) || !same(c.userDirectory, userDirectory) || c.version !== version) return false;
    if (!same(await fs.realpath(path.dirname(configPath)), path.dirname(configPath))) return false;
    await writeJson(path.join(path.dirname(configPath), failure ? 'startup-failed.json' : 'ready.json'), { jobId, version, pid: process.pid, appDirectory: c.appDirectory, ...(failure ? { serviceStopped: true } : {}) });
    return true;
  } catch { return false; }
}
const reportPortableReady = options => reportMarker(options, false);
// Call only after the candidate has confirmed that its owned services stopped.
const reportPortableFailure = options => reportMarker(options, true);
module.exports = { runSwap, reportPortableReady, reportPortableFailure, isPortableUpdateLaunch, validateConfig };
if (require.main === module) {
  const configPath = process.argv[2];
  (async () => {
    const config = await readConfig(configPath);
    if (process.send) await new Promise((resolve, reject) => process.send({ type: 'ready', jobId: config.jobId }, error => error ? reject(error) : resolve()));
    if (process.connected) process.disconnect();
    await runSwap(configPath);
  })().catch(async error => { if (process.send && process.connected) process.send({ type: 'error', message: error.message }); process.exitCode = 1; });
}
