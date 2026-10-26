import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toastPayload, NotificationSettings, notificationMode } from '../src/notifications/settings';
import { NativeNotifications } from '../src/notifications/service';
import { WorkStore } from '../src/work/store';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('an explicit desktop enable/disable choice recovers corrupted settings without a browser URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-notifications-')); roots.push(root); vi.stubEnv('OPENSPEC_NOTIFICATION_TARGET', 'desktop');
  writeFileSync(join(root, 'notifications.json'), '{broken'); const settings = new NotificationSettings(root);
  await settings.update({ enabled: false }); expect(settings.read().enabled).toBe(false);
  writeFileSync(join(root, 'notifications.json'), JSON.stringify({ enabled: 'broken' }));
  await settings.update({ enabled: true }); expect(settings.read().enabled).toBe(true);
});
it('desktop payload never exposes a browser address, token or commands and uses exact app identifiers', () => {
  vi.stubEnv('OPENSPEC_NOTIFICATION_TARGET', 'desktop'); expect(notificationMode()).toBe('desktop');
  const result = toastPayload('https://unused.example/', { workId: 'w&1', questionId: 'q#2', title: '<title>', kind: 'input' });
  expect(result.url).toBe('openspecboard://attention?workId=w%261&questionId=q%232'); expect(result.xml).toContain('&lt;title&gt;');
  expect(result.xml).not.toMatch(/microsoft-edge|unused.example|token|command/);
});
it('desktop settings are independent of legacy browser addresses and protocol failure blocks delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-notifications-')); roots.push(root); vi.stubEnv('DATA_DIR', root); vi.stubEnv('OPENSPEC_NOTIFICATION_TARGET', 'desktop'); vi.stubEnv('OPENSPEC_DESKTOP_PROTOCOL_READY', '0');
  writeFileSync(join(root, 'notifications.json'), JSON.stringify({ enabled: true, dashboardUrl: 'obsolete-address' }));
  expect(new NotificationSettings(root).read().enabled).toBe(true);
  const store = new WorkStore(), adapter: any = { supported: true, register: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
  const service = new NativeNotifications(store, adapter); await service.onApplicationBootstrap();
  expect(service.status()).toMatchObject({ enabled: true, effectiveEnabled: false, activationTarget: 'desktop', lastError: 'activation-error', dashboardUrl: null }); expect(adapter.register).not.toHaveBeenCalled();
  vi.stubEnv('OPENSPEC_DESKTOP_PROTOCOL_READY', '1'); await service.update({ enabled: true });
  expect(adapter.register).toHaveBeenCalledWith('openspecboard://attention'); expect(service.status().effectiveEnabled).toBe(true);
  await expect(service.update({ dashboardUrl: 'http://localhost/' })).rejects.toThrow();
  await service.onApplicationShutdown(); store.onApplicationShutdown();
});
