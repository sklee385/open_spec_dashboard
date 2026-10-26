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
