import { expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

it('독립 프로세스에서 환경 우선·재실행 유지·실행 중 설정 재조회를 확인한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-process-')), config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ sources: [], port: 13002 }));
  const children: ChildProcess[] = [];
  const start = (workspaceRoot?: string) => {
    const env = { ...process.env, CONFIG_PATH: config, DATA_DIR: join(dir, 'data'), TSX_TSCONFIG_PATH: resolve('tsconfig.json') };
    delete env.WORKSPACE_ROOT; if (workspaceRoot) env.WORKSPACE_ROOT = workspaceRoot;
    const child = fork(resolve('test/fixtures/workspace-settings-process.cjs'), [], { execArgv: ['--require', 'tsx/cjs'], env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child); return child;
  };
  const request = async (child: ChildProcess, action = 'read', path?: string) => {
    const reply = once(child, 'message'); child.send({ action, path });
    const [result] = await reply; if (result.error) throw new Error(result.error); return result;
  };
  try {
    const a = start(), initial = await request(a); expect(initial.source).toBe('unset');
    const first = await request(a, 'select', join(dir, 'A'));
    expect(first).toMatchObject({ source: 'saved', path: join(dir, 'A'), version: 1 });
    const b = start(); expect(await request(b)).toEqual(first);
    const second = await request(b, 'select', join(dir, 'B'));
    expect(await request(a)).toEqual(second);
    const crashed = start(); await request(crashed);
    const exited = once(crashed, 'exit'); crashed.send({ action: 'crash-with-lock' });
    expect((await exited)[0]).toBe(21);
    // A dead process must not leave a lock that blocks either space or source settings.
    const afterCrash = await request(b, 'select', join(dir, 'after-crash'));
    expect(afterCrash.version).toBe(3); expect(await request(a)).toEqual(afterCrash);
    const environment = start(join(dir, 'environment'));
    expect(await request(environment)).toMatchObject({ source: 'environment', path: join(dir, 'environment'), profileId: first.profileId });
  } finally {
    await Promise.all(children.map(async child => { if (child.connected) { const exit = once(child, 'exit'); child.send({ action: 'stop' }); await exit; } }));
  }
}, 20_000);
