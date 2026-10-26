import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { delimiter } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localRuntimeDirectory, runtimeCommand, runtimeEnvironment } from '../src/runtime';

afterEach(() => vi.unstubAllEnvs());

it.skipIf(!localRuntimeDirectory())('프로젝트 Node/npm을 직접 실행하며 Volta 중계기를 거치지 않는다', () => {
  const node = runtimeCommand('node', ['--version']);
  const npm = runtimeCommand('npm', ['--version']);
  expect(node.command).toContain('node-runtime');
  expect(npm.command).toBe(node.command);
  expect(npm.args[0]).toMatch(/npm-cli\.js$/);
  expect(execFileSync(node.command, node.args, { env: runtimeEnvironment(), encoding: 'utf8' }).trim()).toMatch(/^v\d+/);
  expect(execFileSync(npm.command, npm.args, { env: runtimeEnvironment(), encoding: 'utf8' }).trim()).toMatch(/^\d+\./);
});
it('자식 실행 PATH에서 프로젝트 런타임을 우선하고 중복된 PATH 키를 제거한다', () => {
  const env = runtimeEnvironment({ Path: 'system-tools', PATH: 'other-tools', KEEP: 'value' }, 'project-node');
  expect(env.PATH?.split(delimiter)[0]).toBe('project-node');
  expect(Object.keys(env).filter(key => key.toLowerCase() === 'path')).toEqual(['PATH']);
  expect(env.KEEP).toBe('value');
});
it('명시적으로 등록한 실행 파일과 인자는 유지한다', () => {
  expect(runtimeCommand('custom-tool', ['literal argument'])).toEqual({ command: 'custom-tool', args: ['literal argument'] });
});
it('패키징된 앱은 지정한 동봉 런타임을 개발 저장소보다 우선한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'packaged-runtime-'));
  writeFileSync(join(dir, process.platform === 'win32' ? 'node.exe' : 'node'), 'fixture');
  mkdirSync(join(dir, 'node_modules', 'npm', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'fixture');
  vi.stubEnv('OPENSPEC_NODE_DIRECTORY', dir);
  expect(localRuntimeDirectory()).toBe(dir);
  expect(runtimeCommand('node', []).command).toBe(join(dir, process.platform === 'win32' ? 'node.exe' : 'node'));
});
