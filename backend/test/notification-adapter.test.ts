import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
vi.unmock('../src/notifications/adapter');
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { WindowsNotifications } from '../src/notifications/adapter';
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
function child() {
  const value: any = new EventEmitter(); value.stdout = new PassThrough(); value.stderr = new PassThrough(); value.stdin = new PassThrough(); value.kill = vi.fn();
  vi.mocked(spawn).mockReturnValue(value); return value;
}
it('passes fixed executable and arguments, data only through stdin, no shell and no automatic browser launch', async () => {
  const value = child(), adapter = new WindowsNotifications(); Object.defineProperty(adapter, 'supported', { value: true });
  const input = { xml: '<toast>" & $(example)</toast>', url: 'microsoft-edge:http://localhost/?workId=x&questionId=q' };
  let sent = ''; value.stdin.on('data', (chunk: Buffer) => { sent += chunk; }); const pending = adapter.show(input);
  value.stdout.write('{"ok":true}'); value.emit('close', 0); await pending;
  const [file, args, options] = vi.mocked(spawn).mock.calls[0];
  expect(String(file)).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1.0[\\/]powershell.exe$/);
  expect(args).toContain('show'); expect(JSON.stringify(args)).not.toContain('example'); expect(options).toMatchObject({ shell: false, windowsHide: true });
  expect(JSON.parse(sent)).toEqual(input); expect(spawn).toHaveBeenCalledTimes(1);
});
it('reports timeout as uncertain, kills children on shutdown and never retries', async () => {
  vi.useFakeTimers(); const value = child(), adapter = new WindowsNotifications(); Object.defineProperty(adapter, 'supported', { value: true });
  const pending = expect(adapter.register('http://localhost/')).rejects.toThrow('uncertain');
  await vi.advanceTimersByTimeAsync(15000); await pending; expect(value.kill).toHaveBeenCalledTimes(1); expect(spawn).toHaveBeenCalledTimes(1);
});
it('reports rejection and unsupported environment without leaking helper logs', async () => {
  const value = child(), adapter = new WindowsNotifications(); Object.defineProperty(adapter, 'supported', { value: true });
  const pending = expect(adapter.unregister()).rejects.toThrow('failed'); value.stderr.write('private data'); value.stdout.write('{"ok":false}'); value.emit('close', 1); await pending;
  const other = new WindowsNotifications(); Object.defineProperty(other, 'supported', { value: false }); await expect(other.register('http://localhost/')).rejects.toThrow('unsupported'); expect(spawn).toHaveBeenCalledTimes(1);
});
