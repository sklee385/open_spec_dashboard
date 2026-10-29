import { createHash } from 'node:crypto';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { excludedNames } from '../work/file-results';
import type { Work, WorkStore } from '../work/store';
import { workspaceResourcePath } from '../work/workspace-file-policy';
import { runGit } from './git-runner';

export interface ChangeBudgetOptions { maxEntries?: number; maxBytes?: number; timeoutMs?: number }
const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const excluded = (work: Work, path: string) => path.split('/').some(part => excludedNames.includes(pathKey(part))) || path.endsWith('.tsbuildinfo') || workspaceResourcePath(work, path);
class BudgetExceeded extends Error {}
export class ChangeBudget {
  readonly deadline: number;
  readonly maxEntries: number;
  private entries = 0;
  private bytes = 0;
  private readonly maxBytes: number;
  constructor(options: ChangeBudgetOptions = {}) {
    this.deadline = Date.now() + (options.timeoutMs ?? 3000); this.maxEntries = options.maxEntries ?? 1000; this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  }
  check() { if (Date.now() >= this.deadline) throw new BudgetExceeded(); }
  entry() { this.check(); if (++this.entries > this.maxEntries) throw new BudgetExceeded(); }
  read(bytes: number) { this.check(); if ((this.bytes += bytes) > this.maxBytes) throw new BudgetExceeded(); }
  gitTimeout() { this.check(); return Math.max(1, this.deadline - Date.now()); }
}
export interface ChangedPaths { paths: Set<string>; partial: boolean }

/** Paths only; no result snapshot or synchronous source reads are constructed for polling. */
export async function workspaceChangedPaths(work: Work, root: string, store: WorkStore, budget: ChangeBudget): Promise<ChangedPaths> {
  const paths = new Set<string>(); let partial = false;
  if (work.workspace?.kind === 'git-worktree') {
    try {
      for (const args of [['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', work.workspace.workspaceBaselineCommit!, '--'], ['ls-files', '--others', '--exclude-standard', '-z']]) {
        const output = await runGit(root, args, { timeoutMs: budget.gitTimeout(), maxOutputBytes: 256 * 1024 });
        for (const path of output.toString('utf8').split('\0').filter(Boolean)) { budget.entry(); if (!excluded(work, path)) paths.add(path); }
        await setImmediate();
      }
    } catch { partial = true; }
    return { paths, partial };
  }
  // Extract only the bounded path/hash projection, never deserialize saved source bodies.
  const baseline = store.db.prepare("SELECT 1 FROM records WHERE work_id=? AND kind='isolated-baseline' LIMIT 1").get(work.id);
  if (!baseline) return { paths, partial: true };
  const rows = store.db.prepare("SELECT key AS path,json_extract(value,'$.hash') AS hash FROM json_each((SELECT data FROM records WHERE work_id=? AND kind='isolated-baseline' LIMIT 1),'$.files') LIMIT ?").all(work.id, budget.maxEntries + 1) as unknown as { path: string; hash: string }[];
  const base = new Map(rows.map(row => [row.path, row.hash])), seen = new Set<string>();
  partial ||= rows.length > budget.maxEntries;
  const visit = async (directory: string, prefix = '') => {
    budget.check(); const beforeDirectory = await lstat(directory);
    if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink() || pathKey(await realpath(directory)) !== pathKey(resolve(directory))) throw new Error('Directory ownership changed');
    const entries = await opendir(directory);
    for await (const entry of entries) {
      budget.entry(); const path = prefix ? `${prefix}/${entry.name}` : entry.name, absolute = join(directory, entry.name);
      if (excluded(work, path) || pathKey(absolute) === pathKey(resolve(process.env.DATA_DIR || '../.data'))) continue;
      const before = await lstat(absolute);
      if (before.isSymbolicLink()) throw new Error('Linked source');
      if (before.isDirectory()) {
        try { await lstat(join(absolute, '.git')); throw new Error('Nested Git source'); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
        await visit(absolute, path); continue;
      }
      if (!before.isFile() || before.nlink !== 1 || pathKey(await realpath(absolute)) !== pathKey(resolve(absolute))) throw new Error('Shared source');
      seen.add(path); budget.read(before.size);
      // Large files remain unconfirmed rather than blocking a poll with a full read/hash.
      if (before.size >= 200000) { partial = true; continue; }
      const handle = await open(absolute, 'r');
      try {
        const opened = await handle.stat();
        if (opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || !opened.isFile()) throw new Error('Source ownership changed');
        const buffer = Buffer.alloc(before.size + 1); let length = 0;
        while (length < buffer.length) {
          budget.check(); const read = await handle.read(buffer, length, Math.min(64 * 1024, buffer.length - length), length);
          if (!read.bytesRead) break; length += read.bytesRead;
        }
        if (length !== before.size) throw new Error('Source size changed');
        const bytes = buffer.subarray(0, length); budget.check(); const after = await lstat(absolute);
        if (after.isSymbolicLink() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.mode !== before.mode) throw new Error('Source changed while reading');
        const normalized = /(^|\/)tasks\.md$/.test(path) && !bytes.includes(0) ? bytes.toString('utf8').replace(/- \[[xX ]\]/g, '- [ ]') : bytes;
        if (createHash('sha256').update(normalized).digest('hex') !== base.get(path)) paths.add(path);
      } finally { await handle.close(); }
      await setImmediate();
    }
    budget.check(); const afterDirectory = await lstat(directory);
    if (afterDirectory.isSymbolicLink() || afterDirectory.dev !== beforeDirectory.dev || afterDirectory.ino !== beforeDirectory.ino || afterDirectory.mtimeMs !== beforeDirectory.mtimeMs) throw new Error('Directory changed while reading');
  };
  try {
    await visit(root);
    if (!partial) for (const path of base.keys()) { budget.entry(); if (!excluded(work, path) && !seen.has(path)) paths.add(path); }
  } catch { partial = true; }
  return { paths, partial };
}
