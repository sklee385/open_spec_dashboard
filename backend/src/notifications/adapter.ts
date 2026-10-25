import { Injectable } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

export const NOTIFICATION_APP_ID = 'OpenSpecBoard.Notifications';
@Injectable()
export class WindowsNotifications {
  readonly supported = process.platform === 'win32';
  private children = new Set<ChildProcess>();
  register(dashboardUrl: string) { return this.run('register', { dashboardUrl }); }
  unregister() { return this.run('unregister', {}); }
  show(payload: { xml: string; url: string }) { return this.run('show', payload); }
  close() { for (const child of this.children) child.kill(); }
  private run(action: 'register' | 'unregister' | 'show', data: unknown): Promise<void> {
    if (!this.supported) return Promise.reject(new Error('unsupported'));
    return new Promise((accept, reject) => {
      const executable = resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', resolve(__dirname, '../../scripts/windows-notifications.ps1'), '-Action', action], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.children.add(child); let output = '', settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timeout); this.children.delete(child); error ? reject(error) : accept(); };
      const timeout = setTimeout(() => { child.kill(); finish(new Error('uncertain')); }, 15000);
      child.stdout?.setEncoding('utf8'); child.stdout?.on('data', chunk => { output += chunk; if (output.length > 4096) { child.kill(); finish(new Error('uncertain')); } });
      child.stderr?.resume(); child.on('error', () => finish(new Error('failed')));
      child.on('close', code => { try { if (code !== 0 || JSON.parse(output).ok !== true) throw new Error(); finish(); } catch { finish(new Error(code === null ? 'uncertain' : 'failed')); } });
      child.stdin?.on('error', () => { /* Exit handler records delivery result. */ }); child.stdin?.end(JSON.stringify(data));
    });
  }
}
