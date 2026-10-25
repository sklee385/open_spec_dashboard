import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationSettings, dashboardUrl, toastPayload } from '../src/notifications/settings';
import { NativeNotifications } from '../src/notifications/service';
import { WorkStore } from '../src/work/store';

const dirs: string[] = [];
const dir = () => { const value = mkdtempSync(join(tmpdir(), 'native-notifications-')); dirs.push(value); return value; };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const value of dirs.splice(0)) rmSync(value, { recursive: true, force: true }); });
describe('native notifications', () => {
  it('runs one browser-independent loop five seconds after completion, rechecks pending and stops on shutdown', async () => {
    vi.useFakeTimers(); vi.stubEnv('DATA_DIR', dir()); const store = new WorkStore();
    store.save({ id: 'w', sourceId: 's', changeName: 'c', requestKey: 'w', createdAt: 'now' } as any);
    let resolve!: () => void;
    const adapter: any = { supported: true, register: vi.fn().mockResolvedValue(undefined), show: vi.fn().mockImplementationOnce(() => new Promise<void>(r => { resolve = r; })).mockResolvedValue(undefined), close: vi.fn() };
    const service = new NativeNotifications(store, adapter); await service.onApplicationBootstrap();
    store.record('q', 'w', 'question', { kind: 'input', status: 'pending' });
    await vi.advanceTimersByTimeAsync(5000); expect(adapter.show).toHaveBeenCalledTimes(1);
    await service.scan(); await vi.advanceTimersByTimeAsync(10000); expect(adapter.show).toHaveBeenCalledTimes(1);
    resolve(); await vi.advanceTimersByTimeAsync(0);
    store.record('q2', 'w', 'question', { kind: 'input', status: 'pending' });
    const claim = vi.spyOn(store, 'claimNative');
    claim.mockImplementation(item => { const result = WorkStore.prototype.claimNative.call(store, item); store.record(item.questionId, 'w', 'question', { kind: 'input', status: 'expired' }); return result; });
    await vi.advanceTimersByTimeAsync(4999); expect(adapter.show).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(adapter.show).toHaveBeenCalledTimes(1); claim.mockRestore();
    await service.onApplicationShutdown(); await vi.advanceTimersByTimeAsync(10000); expect(adapter.close).toHaveBeenCalledTimes(1); store.onApplicationShutdown();
  });
  it('defaults on, saves off atomically and prioritizes the stored local URL', async () => {
    const root = dir(); vi.stubEnv('OPENSPEC_DASHBOARD_URL', 'http://localhost:14001/board/');
    const settings = new NotificationSettings(root); expect(settings.read().enabled).toBe(true);
    await settings.update({ enabled: false, dashboardUrl: 'https://[::1]:444/' });
    vi.stubEnv('OPENSPEC_DASHBOARD_URL', 'http://localhost:9999/');
    expect(new NotificationSettings(root).read()).toEqual({ enabled: false, dashboardUrl: 'https://[::1]:444/' });
    expect(JSON.parse(readFileSync(join(root, 'notifications.json'), 'utf8')).enabled).toBe(false);
    await expect(settings.update({ effectiveEnabled: true })).rejects.toThrow();
  });
  it('rejects external URLs, credentials, query, fragment and corrupt settings', () => {
    for (const url of ['https://example.com/', 'http://localhost.evil/', 'http://user@localhost/', 'http://localhost/?x=1', 'http://localhost/#x', 'file:///x']) expect(() => dashboardUrl(url)).toThrow();
    const root = dir(); writeFileSync(join(root, 'notifications.json'), '{broken');
    expect(() => new NotificationSettings(root).read()).toThrow();
  });
  it('escapes private-safe protocol toast with one default sound and no commands', () => {
    const payload = toastPayload('http://127.0.0.1:13001/', { workId: 'w&1', questionId: 'q#2', title: '<hello>', kind: 'approval' });
    expect(payload.xml).toContain('activationType="protocol"'); expect(payload.xml).toContain('&lt;hello&gt;');
    expect(payload.xml).toContain('ms-winsoundevent:Notification.Default'); expect(payload.xml).not.toContain('silent="true"');
    expect(payload.url).toBe('microsoft-edge:http://127.0.0.1:13001/?workId=w%261&questionId=q%232');
  });
  it('claims once across stores and restart, never retries clear or uncertain failures', async () => {
    const root = dir(); vi.stubEnv('DATA_DIR', root);
    const store = new WorkStore(); const other = new WorkStore();
    const work: any = { id: 'w', sourceId: 's', changeName: 'c', requestKey: 'k', createdAt: new Date().toISOString() }; store.save(work);
    store.record('q', 'w', 'question', { kind: 'input', status: 'pending' });
    const adapter: any = { supported: true, register: vi.fn().mockResolvedValue(undefined), show: vi.fn().mockRejectedValue(new Error('failed')), close: vi.fn() };
    const service = new NativeNotifications(store, adapter); await service.onApplicationBootstrap(); await service.scan();
    expect(adapter.show).toHaveBeenCalledTimes(1); expect(other.claimNative(store.attention()[0])).toBe(false);
    await service.onApplicationShutdown(); const restarted = new NativeNotifications(other, adapter); await restarted.onApplicationBootstrap();
    expect(adapter.show).toHaveBeenCalledTimes(1); expect(restarted.status().lastError).toBeTruthy();
    await restarted.onApplicationShutdown(); other.onApplicationShutdown(); store.onApplicationShutdown();
  });
  it('honors stored off and registration failure without browser requests', async () => {
    const root = dir(); vi.stubEnv('DATA_DIR', root); const settings = new NotificationSettings(root); await settings.update({ enabled: false });
    const store = new WorkStore(); const adapter: any = { supported: true, register: vi.fn().mockRejectedValue(new Error()), close: vi.fn() };
    const service = new NativeNotifications(store, adapter); await service.onApplicationBootstrap(); expect(adapter.register).not.toHaveBeenCalled();
    await service.update({ enabled: true }); expect(service.status()).toMatchObject({ enabled: true, effectiveEnabled: false, registrationStatus: 'failed' });
    await service.onApplicationShutdown(); store.onApplicationShutdown();
  });
  it('recovers an invalid address only through explicit valid settings', async () => {
    const root = dir(); vi.stubEnv('OPENSPEC_DASHBOARD_URL', 'https://external.example/');
    const settings = new NotificationSettings(root); expect(() => settings.read()).toThrow();
    await settings.update({ dashboardUrl: 'http://localhost:13001/' }); expect(settings.read().enabled).toBe(true);
    writeFileSync(join(root, 'notifications.json'), JSON.stringify({ enabled: false, dashboardUrl: 'invalid' }));
    await settings.update({ dashboardUrl: 'http://localhost:15001/' }); expect(settings.read().enabled).toBe(false);
  });
  it('retains readable intent when a stored URL is invalid and blocks real delivery', async () => {
    const root = dir(); vi.stubEnv('DATA_DIR', root); writeFileSync(join(root, 'notifications.json'), JSON.stringify({ enabled: true, dashboardUrl: 'https://external.example/' }));
    const store = new WorkStore(); const adapter: any = { supported: true, register: vi.fn(), close: vi.fn() };
    const service = new NativeNotifications(store, adapter); await service.onApplicationBootstrap();
    expect(service.status()).toMatchObject({ enabled: true, effectiveEnabled: false, lastError: 'settings-error' }); expect(adapter.register).not.toHaveBeenCalled();
    await service.onApplicationShutdown(); store.onApplicationShutdown();
  });
  it('does not call the OS when claiming fails or a pending request expires, recovers abandoned claims', async () => {
    const root = dir(); vi.stubEnv('DATA_DIR', root); const store = new WorkStore();
    store.save({ id: 'w', sourceId: 's', changeName: 'c', requestKey: 'w', createdAt: 'now' } as any);
    store.record('q', 'w', 'question', { kind: 'input', status: 'pending' });
    const item = store.attention()[0]; expect(store.claimNative(item)).toBe(true); store.recoverNative();
    expect(store.records('w', 'native-notification')[0].state).toBe('uncertain');
    store.record('q2', 'w', 'question', { kind: 'input', status: 'pending' });
    const adapter: any = { supported: true, register: vi.fn().mockResolvedValue(undefined), show: vi.fn(), close: vi.fn() };
    const claim = vi.spyOn(store, 'claimNative').mockImplementation(() => { throw new Error('disk'); });
    const service = new NativeNotifications(store, adapter); await service.onApplicationBootstrap(); expect(adapter.show).not.toHaveBeenCalled(); expect(service.status().effectiveEnabled).toBe(false);
    claim.mockRestore(); await service.onApplicationShutdown(); store.onApplicationShutdown();
  });
});
