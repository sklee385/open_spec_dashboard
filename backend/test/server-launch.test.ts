import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'win32' || process.env.RUN_SERVER_LAUNCH_TESTS !== '1')('서버가 모든 Windows Job에서 분리되고 stdout·stderr 로그를 남긴다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'server launch '));
  const output = execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', resolve('test/fixtures/server-launch.ps1'),
    '-Runtime', process.execPath, '-Launcher', resolve('../scripts/start-detached.ps1'), '-Directory', directory], { encoding: 'utf8', timeout: 45000, windowsHide: true });
  expect(output).toContain('independent process and redirected logs verified');
}, 50000);

it.skipIf(process.platform !== 'win32' || process.env.RUN_SERVER_LAUNCH_TESTS !== '1')('기존 Start-Process 방식이 부모 명령 Job을 상속하는 문제를 재현한다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'attached server '));
  const output = execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', resolve('test/fixtures/server-launch.ps1'),
    '-Runtime', process.execPath, '-Launcher', resolve('test/fixtures/attached-launch.ps1'), '-Directory', directory, '-ExpectAttached'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  expect(output).toContain('old launcher inherits the command job');
});
