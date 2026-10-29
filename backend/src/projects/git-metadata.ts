import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Small metadata pointers preserve worktree coordination even without Git installed. */
export function gitCommonDirectory(root: string): string | null {
  const pointer = (path: string) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid Git pointer');
    return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  };
  try {
    const dotGit = join(root, '.git'), stat = lstatSync(dotGit);
    if (stat.isSymbolicLink()) return null;
    if (stat.isDirectory()) return realpathSync(dotGit);
    const text = pointer(dotGit);
    if (!text.startsWith('gitdir: ')) return null;
    const directory = realpathSync(resolve(root, text.slice(8)));
    try { return realpathSync(resolve(directory, pointer(join(directory, 'commondir')))); }
    catch { return directory; }
  } catch { return null; }
}
export function gitHeadRef(root: string): string | null {
  const text = (path: string) => { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error('Invalid Git ref pointer'); return readFileSync(path, 'utf8').trim(); };
  const pointer = join(root, '.git'); let stat;
  try { stat = lstatSync(pointer); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink()) throw new Error('Invalid Git directory');
  let directory: string;
  if (stat.isDirectory()) directory = realpathSync(pointer);
  else { const value = text(pointer); if (!value.startsWith('gitdir: ')) throw new Error('Invalid Git directory pointer'); directory = realpathSync(resolve(root, value.slice(8))); }
  const head = text(join(directory, 'HEAD'));
  if (head.startsWith('ref: refs/')) return resolveGitRef(root, head.slice(5), directory);
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) return null;
  throw new Error('Invalid Git HEAD');
}
/** Resolve an explicitly targeted ref as well as HEAD before persisting its lock identity. */
export function resolveGitRef(root: string, input: string, directory?: string): string {
    const text = (path: string) => { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error('Invalid Git ref pointer'); return readFileSync(path, 'utf8').trim(); };
    if (!directory) {
      const pointer = join(root, '.git'), stat = lstatSync(pointer);
      if (stat.isSymbolicLink()) throw new Error('Invalid Git directory');
      if (stat.isDirectory()) directory = realpathSync(pointer);
      else { const value = text(pointer); if (!value.startsWith('gitdir: ')) throw new Error('Invalid Git directory pointer'); directory = realpathSync(resolve(root, value.slice(8))); }
    }
    const common = gitCommonDirectory(root); if (!common) throw new Error('Invalid Git common directory');
    let ref = input; const seen = new Set<string>();
    for (let depth = 0; depth < 16; depth++) {
      if (!ref.startsWith('refs/') || ref.length > 1024 || /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.endsWith('.') || ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')) || seen.has(ref)) throw new Error('Invalid Git symbolic ref');
      seen.add(ref);
      const base = /^refs\/(?:bisect|worktree|rewritten)\//.test(ref) ? directory : common;
      let value: string;
      try { value = text(join(base, ref)); }
      catch (error: any) { if (error.code === 'ENOENT') return ref; throw error; }
      if (value.startsWith('ref: ')) { ref = value.slice(5); continue; }
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) return ref;
      throw new Error('Invalid Git ref');
    }
    throw new Error('Git symbolic ref depth exceeded');
}
