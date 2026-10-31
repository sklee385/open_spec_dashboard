import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export type TestScope = 'work' | 'full';
export interface TestCommand { id: string; command: string; args: string[]; reason?: string; }

/** IDs are display labels; an executable/argument tuple is the execution identity. */
export function uniqueTestCommands<T extends TestCommand>(commands: T[]): T[] {
  const seen = new Set<string>();
  return commands.filter(command => {
    const key = JSON.stringify([command.command, command.args]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function sharedTestConfiguration(path: string): boolean {
  // A feature named config.ts or setup.ts is ordinary source. Only declared runner
  // settings and dependency/build inputs justify broadening the default plan.
  return /(^|\/)(package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|(?:vitest|vite|jest|webpack|rollup|tsconfig)(?:\.[^/]+)?\.(?:[cm]?[jt]s|json)|\.npmrc)$/.test(path);
}

/** Inspect literal config dependencies without importing or executing project code. */
function configInputs(root: string, project: string, options: string[]): Set<string> {
  const inputs = new Set<string>(), pending = readdirSync(project).filter(name => /^(?:vite|vitest)\.config\.[cm]?[jt]s$/.test(name)).map(name => join(project, name));
  for (let i = 0; i < options.length; i++) {
    const path = options[i] === '--config' ? options[i + 1] : options[i].startsWith('--config=') ? options[i].slice(9) : undefined;
    if (path) pending.push(resolve(project, path));
  }
  while (pending.length && inputs.size < 64) {
    const file = pending.pop()!, path = relative(root, file).replaceAll('\\', '/');
    if (isAbsolute(path) || path === '..' || path.startsWith('../') || inputs.has(path) || !existsSync(file)) continue;
    inputs.add(path);
    let text: string; try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (text.length > 512000) continue;
    for (const match of text.matchAll(/['"]((?:\.\.?\/|src\/|test\/)[^'"\r\n]+)['"]/g)) {
      const base = resolve(dirname(file), match[1]);
      for (const suffix of ['', '.ts', '.tsx', '.js', '.mjs', '.json']) if (existsSync(base + suffix)) { pending.push(base + suffix); break; }
    }
  }
  return inputs;
}

/** Discover only known non-interactive Vitest projects; never guess commands for other runners. */
export function relatedTestCommands(root: string, changed: (string | { path: string; before?: string | null; after?: string | null })[]): TestCommand[] {
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
  const files = changed.filter(file => {
    if (typeof file === 'string' || !/(^|\/)package\.json$/.test(file.path) || !file.before || !file.after) return true;
    try { const before = JSON.parse(file.before), after = JSON.parse(file.after); delete before.version; delete after.version; return JSON.stringify(before) !== JSON.stringify(after); } catch { return true; }
  }).map(file => typeof file === 'string' ? file : file.path).filter(file => !isAbsolute(file) && !file.split(/[\\/]/).includes('..') && !file.startsWith('openspec/'));
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
    const add = (kind: string, args: string[], reason: string) => commands.push({ id: `work:${label}:${kind}`, command: process.env.NPM_BIN || 'npm', args: [...prefix, ...args, ...runnerOptions, ...(runnerOptions.some(arg => /^--maxWorkers(?:=|$)/.test(arg)) ? [] : ['--maxWorkers=1'])], reason });
    const sharedInputs = configInputs(root, project, runnerOptions);
    const broad = ownFiles.some(file => sharedTestConfiguration(file.replaceAll('\\', '/')) || sharedInputs.has(file.replaceAll('\\', '/')));
    if (broad) { add('tests', ['run'], '의존성 또는 공통 실행·빌드 설정이 변경되어 해당 프로젝트 전체를 검사합니다.'); continue; }
    const tests = ownFiles.filter(file => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && existsSync(resolve(root, file)));
    const sources = ownFiles.filter(file => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && /\.(?:[cm]?[jt]sx?|json|vue|svelte|css|scss)$/.test(file));
    const paths = (list: string[]) => list.map(file => relative(project, resolve(root, file)).replaceAll('\\', '/'));
    const targets = [...new Set(paths([...sources, ...tests]))];
    if (targets.length) add('related', ['related', ...targets, '--run'], '변경 소스에 의존하는 테스트와 직접 변경한 테스트를 한 번씩 검사합니다.');
  }
  return uniqueTestCommands(commands);
}
