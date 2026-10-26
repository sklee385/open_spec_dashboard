import { BadRequestException, Body, Controller, Get, Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Put } from '@nestjs/common';
import { WorkStore } from '../work/store';
import { WindowsNotifications } from './adapter';
import { NotificationConfig, NotificationSettings, toastPayload, notificationMode, notificationLaunchURI } from './settings';

@Injectable()
export class NativeNotifications implements OnApplicationBootstrap, OnApplicationShutdown {
  private settings = new NotificationSettings();
  private config?: NotificationConfig;
  private intent: boolean | null = null;
  private registrationStatus = 'uninitialized';
  private lastError: string | null = null;
  private stopped = false; private scanning = false; private updating = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(@Inject(WorkStore) private readonly store: WorkStore, @Inject(WindowsNotifications) private readonly adapter: WindowsNotifications) {}
  status() {
    let deliveryError: string | null = null;
    try { deliveryError = this.store.nativeProblem(); } catch { this.lastError = 'storage-error'; this.registrationStatus = 'failed'; }
    return { enabled: this.config?.enabled ?? this.intent, dashboardUrl: notificationMode() === 'desktop' ? null : this.config?.dashboardUrl ?? null, activationTarget: notificationMode(),
    effectiveEnabled: !!this.config?.enabled && this.registrationStatus === 'registered' && !this.stopped && !this.updating,
    registrationStatus: this.registrationStatus, lastError: this.lastError || deliveryError }; }
  async onApplicationBootstrap() {
    try { this.store.recoverNative(); await this.configure(); } catch { this.registrationStatus = 'failed'; this.lastError = 'storage-error'; }
    await this.scan(); this.schedule();
  }
  private async configure() {
    this.registrationStatus = 'uninitialized'; this.lastError = null;
    try { this.config = this.settings.read(); this.intent = this.config.enabled; } catch { this.config = undefined; this.intent = this.settings.readIntent(); this.registrationStatus = 'failed'; this.lastError = 'settings-error'; return; }
    if (!this.config.enabled) { this.registrationStatus = 'disabled'; return; }
    if (notificationMode() === 'desktop' && process.env.OPENSPEC_DESKTOP_PROTOCOL_READY !== '1') { this.registrationStatus = 'failed'; this.lastError = 'activation-error'; return; }
    if (!this.adapter.supported) { this.registrationStatus = 'unsupported'; this.lastError = 'unsupported'; return; }
    try { await this.adapter.register(notificationLaunchURI(this.config.dashboardUrl)); if (!this.stopped) this.registrationStatus = 'registered'; }
    catch { this.registrationStatus = 'failed'; this.lastError = 'registration-error'; }
  }
  async update(input: unknown) {
    if (this.updating || this.scanning) throw new BadRequestException('알림 처리 중입니다. 잠시 후 다시 시도하세요.');
    this.updating = true;
    try {
      await this.settings.update(input); await this.configure();
      if ((input as any).unregister) {
        try { await this.adapter.unregister(); this.registrationStatus = 'unregistered'; } catch { this.lastError = 'unregister-error'; this.registrationStatus = 'failed'; }
      }
    } catch (error) {
      if (!(error instanceof BadRequestException)) { this.lastError = 'settings-error'; this.registrationStatus = 'failed'; }
      throw error;
    }
    finally { this.updating = false; }
    await this.scan(); return this.status();
  }
  private schedule() { if (!this.stopped) { this.timer = setTimeout(async () => { await this.scan(); this.schedule(); }, 5000); this.timer.unref(); } }
  async scan() {
    if (this.stopped || this.scanning || this.updating || !this.status().effectiveEnabled || !this.config) return;
    this.scanning = true;
    try {
      for (const item of this.store.attention()) {
        if (this.stopped || !this.store.attention().some(row => row.workId === item.workId && row.questionId === item.questionId)) continue;
        if (!this.store.claimNative(item)) continue;
        if (this.stopped || !this.store.attention().some(row => row.workId === item.workId && row.questionId === item.questionId)) { this.store.finishNative(item, 'uncertain'); continue; }
        let state: 'submitted' | 'failed' | 'uncertain' = 'submitted';
        try { await this.adapter.show(toastPayload(this.config.dashboardUrl, item)); }
        catch (error) { state = error instanceof Error && error.message === 'failed' ? 'failed' : 'uncertain'; }
        this.store.finishNative(item, state);
      }
    } catch { this.lastError = 'storage-error'; this.registrationStatus = 'failed'; }
    finally { this.scanning = false; }
  }
  async onApplicationShutdown() { this.stopped = true; clearTimeout(this.timer); this.adapter.close(); }
}
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(NativeNotifications) private readonly notifications: NativeNotifications) {}
  @Get('settings') get() { return this.notifications.status(); }
  @Put('settings') update(@Body() body: unknown) { return this.notifications.update(body); }
}
