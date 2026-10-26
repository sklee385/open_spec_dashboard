import { useI18n } from '@/i18n/context';
import type { enRecoveryCopy } from '@/i18n/recoveryMessages';

export type RecoveryStatus = { required: boolean; canReconnect: boolean; code: string; mode?: 'shared' | 'isolated' };
const reasons: Record<string, keyof typeof enRecoveryCopy> = {
  'legacy-workspace': 'recovery.legacy', 'isolated-workspace': 'recovery.isolated',
  'workspace-unavailable': 'recovery.workspace', 'project-unavailable': 'recovery.project',
  'thread-in-use': 'recovery.inUse', 'session-restarted': 'recovery.restarted',
  'thread-unknown': 'recovery.unknown', 'connection-failed': 'recovery.failed', busy: 'recovery.busy', completed: 'recovery.completed',
};
export function WorkRecovery({ status, busy, error, onRecover }: { status: RecoveryStatus; busy: boolean; error?: string; onRecover: () => void }) {
  const { t } = useI18n();
  return <section className="work-recovery work-notice" aria-label={t('recovery.title')}>
    <p role="status">{t(reasons[status.code] || 'recovery.failed')}</p>
    <button disabled={busy || !status.canReconnect} onClick={onRecover}>{t(busy ? 'recovery.working' : 'recovery.action')}</button>
    {error && <details><summary>{t('recovery.details')}</summary><p>{error}</p></details>}
  </section>;
}
