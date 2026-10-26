import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export type TestScope = 'work' | 'full';
export interface TestCommand { id: string; command: string; args: string[]; }

/** Discover only known non-interactive Vitest projects; never guess commands for other runners. */
export function relatedTestCommands(root: string, changed: string[]): TestCommand[] {
  const read = (folder: string) => {
    const file = join(folder, 'package.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  };
  const pkg = read(root);
  const patterns: string[] = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages || [];
  const folders = new Set<string>(['']);
  const expand = (folder: string, parts: string[]) => {
    if (!parts.length) { folders.add(folder); return; }
    const [part, ...rest] = parts;
    if (part.includes('*')) {
      const pattern = new RegExp(`^${part.split('*').map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      if (existsSync(join(root, folder))) for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink() && pattern.test(entry.name)) expand(join(folder, entry.name), rest);
    } else if (part && part !== '.' && part !== '..') expand(join(folder, part), rest);
  };
  for (const pattern of patterns) if (typeof pattern === 'string' && !isAbsolute(pattern) && !pattern.includes('..')) expand('', pattern.replaceAll('\\', '/').split('/'));
  const files = changed.filter(file => !isAbsolute(file) && !file.split(/[\\/]/).includes('..') && !file.startsWith('openspec/'));
  if (!files.length) return [];
  const commands: TestCommand[] = [];
  for (const folder of folders) {
    const project = resolve(root, folder), scripts = read(project).scripts || {};
    const script = scripts['test:run'] || scripts.test;
    if (typeof script !== 'string' || !/^vitest(?:\s|$)/.test(script)) continue;
    // Preserve runner settings, but leave shell expressions to an explicit command plan.
    if (/[;&|<>`\r\n]|\$\(/.test(script)) continue;
    const options = (script.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).slice(1).map(arg => arg.replace(/^(['"])(.*)\1$/, '$2'));
    if (options[0] === 'run') options.shift();
    const runnerOptions = options.filter(arg => !['--run', '--watch', '-w', '--ui', '--open'].includes(arg) && !/^--(watch|ui|open)=/.test(arg));
    const ownFiles = files.filter(file => !folder || file.replaceAll('\\', '/').startsWith(folder.replaceAll('\\', '/') + '/') || ![...folders].some(other => other && file.replaceAll('\\', '/').startsWith(other.replaceAll('\\', '/') + '/')));
    if (!ownFiles.length) continue;
    const prefix = ['exec', '--offline', ...(folder ? ['--workspace', folder] : []), '--', 'vitest'];
    const label = folder ? `${folder.replace(/[^a-zA-Z0-9_-]/g, '_')}_${createHash('sha256').update(folder).digest('hex').slice(0, 8)}` : 'root';
    const add = (kind: string, args: string[]) => commands.push({ id: `work:${label}:${kind}`, command: process.env.NPM_BIN || 'npm', args: [...prefix, ...args, ...runnerOptions, '--maxWorkers=1'] });
    const broad = ownFiles.some(file => /(^|\/)(package(-lock)?\.json|[^/]*config\.[^/]+|[^/]*setup\.[^/]+)$/.test(file.replaceAll('\\', '/')));
    if (broad) { add('tests', ['run']); continue; }
    const tests = ownFiles.filter(file => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && existsSync(resolve(root, file)));
    const sources = ownFiles.filter(file => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && /\.[cm]?[jt]sx?$/.test(file));
    const paths = (list: string[]) => list.map(file => relative(project, resolve(root, file)).replaceAll('\\', '/'));
    if (sources.length) add('related', ['related', ...paths(sources), '--run']);
    if (tests.length) add('files', ['run', ...paths(tests)]);
  }
  return commands;
}
