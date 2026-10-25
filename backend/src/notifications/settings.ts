import { BadRequestException } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWrite, textFile } from '../files';

export interface NotificationConfig { enabled: boolean; dashboardUrl: string }
export function dashboardUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048 || /[\x00-\x20\\]/.test(input)) throw new BadRequestException('Invalid dashboard URL');
  let url: URL; try { url = new URL(input); } catch { throw new BadRequestException('Invalid dashboard URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || input.includes('?') || input.includes('#')) throw new BadRequestException('A local dashboard URL without query or fragment is required');
  return url.href;
}
export class NotificationSettings {
  private readonly path: string;
  constructor(dir = resolve(process.env.DATA_DIR || '../.data')) { mkdirSync(dir, { recursive: true }); this.path = join(dir, 'notifications.json'); }
  readIntent(): boolean | null {
    try { const raw = textFile(this.path); if (raw === null) return true; const value = JSON.parse(raw).enabled; return typeof value === 'boolean' ? value : null; } catch { return null; }
  }
  read(): NotificationConfig {
    const raw = textFile(this.path);
    if (raw === null) {
      const config = { enabled: true, dashboardUrl: dashboardUrl(process.env.OPENSPEC_DASHBOARD_URL ?? 'http://127.0.0.1:13001/') };
      atomicWrite(this.path, JSON.stringify(config, null, 2)); return config;
    }
    const config = JSON.parse(raw);
    if (typeof config.enabled !== 'boolean') throw new Error('Invalid notification settings');
    return { enabled: config.enabled, dashboardUrl: dashboardUrl(config.dashboardUrl) };
  }
  async update(value: unknown): Promise<NotificationConfig> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Invalid settings');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !['enabled', 'dashboardUrl', 'unregister'].includes(key)) || !Object.keys(input).length
      || ('enabled' in input && typeof input.enabled !== 'boolean') || ('unregister' in input && input.unregister !== true)
      || (input.unregister === true && input.enabled !== false)) throw new BadRequestException('Invalid settings');
    let current: NotificationConfig;
    try { current = this.read(); }
    catch {
      // An explicit address repair may recover an invalid deployment/stored URL,
      // while retaining a readable stored intent. Corrupt intent needs both fields.
      if (input.dashboardUrl === undefined) throw new BadRequestException('주소와 사용 설정을 다시 지정하세요.');
      const raw = textFile(this.path); let stored: any;
      try { stored = raw === null ? { enabled: true } : JSON.parse(raw); } catch { stored = {}; }
      const intent = input.enabled ?? stored.enabled;
      if (typeof intent !== 'boolean') throw new BadRequestException('주소와 사용 설정을 다시 지정하세요.');
      current = { enabled: intent, dashboardUrl: dashboardUrl(input.dashboardUrl) };
    }
    const config = { enabled: input.enabled === undefined ? current.enabled : input.enabled as boolean, dashboardUrl: input.dashboardUrl === undefined ? current.dashboardUrl : dashboardUrl(input.dashboardUrl) };
    atomicWrite(this.path, JSON.stringify(config, null, 2)); return config;
  }
}
const escapeXml = (value: string) => value.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]!));
export function toastPayload(base: string, item: { workId: string; questionId: string; title: string; kind: string }) {
  const target = new URL(dashboardUrl(base)); target.searchParams.set('workId', item.workId); target.searchParams.set('questionId', item.questionId);
  const url = `microsoft-edge:${target.href}`;
  const title = item.title.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, 200);
  return { url, xml: `<toast activationType="protocol" launch="${escapeXml(url)}"><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${item.kind === 'approval' ? '승인 필요' : '답변 필요'}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default" loop="false"/></toast>` };
}
