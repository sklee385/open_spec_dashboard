import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';

export function localRuntimeDirectory(): string | undefined {
  const configured = process.env.OPENSPEC_NODE_DIRECTORY;
  if (configured) {
    if (!existsSync(join(configured, process.platform === 'win32' ? 'node.exe' : 'node'))) throw new Error('동봉 Node 런타임이 없습니다');
    return configured;
  }
  let folder = __dirname;
  while (dirname(folder) !== folder) {
    const runtime = join(folder, '.tools', 'node-runtime');
    if (existsSync(join(runtime, 'node.exe')) && existsSync(join(runtime, 'node_modules', 'npm', 'bin', 'npm-cli.js'))) return runtime;
    folder = dirname(folder);
  }
}

export function runtimeEnvironment(base: NodeJS.ProcessEnv = process.env, directory = localRuntimeDirectory()): NodeJS.ProcessEnv {
  if (!directory) return { ...base };
  const env = { ...base };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const previous = pathKey ? env[pathKey] || '' : '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [directory, ...previous.split(delimiter).filter(value => value && value.toLowerCase() !== directory.toLowerCase())].join(delimiter);
  return env;
}

export function runtimeCommand(command: string, args: string[], directory = localRuntimeDirectory()): { command: string; args: string[] } {
  if (!directory || basename(command) !== command) return { command, args };
  const name = command.toLowerCase().replace(/\.(exe|cmd|ps1)$/, '');
  const executable = join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  if (name === 'node') return { command: executable, args };
  if (name === 'npm' || name === 'npx') return { command: executable, args: [join(directory, 'node_modules', 'npm', 'bin', `${name}-cli.js`), ...args] };
  return { command, args };
}
