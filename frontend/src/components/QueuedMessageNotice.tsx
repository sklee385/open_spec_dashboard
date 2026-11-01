import { useState } from 'react';
import { useI18n } from '../i18n/context';

export type QueuedMessage = { id: string; text: string; status: string; error?: string };

/** Presentation only: a changed request/version/status must be visible again. */
export function QueuedMessageNotice({ message }: { message: QueuedMessage }) {
  const { t } = useI18n();
  const [closedSignature, setClosedSignature] = useState<string | null>(null);
  const signature = JSON.stringify([message.id, message.text, message.status, message.error ?? null]);
  const collapsed = closedSignature === signature;
  const label = message.status === 'queued' ? t('workRoom.queued') : message.status === 'dispatching' ? t('workRoom.dispatching') : t('workRoom.queueCheck');
  return <div className="work-notice">
    <button type="button" aria-expanded={!collapsed} onClick={() => setClosedSignature(collapsed ? null : signature)}>{collapsed ? t('workRoom.showQueueNotice') : t('workRoom.closeQueueNotice')}</button>
    {collapsed ? <span> {label}</span> : <><div>{label}: {message.text}</div><p>{message.error}{['blocked', 'uncertain'].includes(message.status) && t('workRoom.queueHint')}</p></>}
  </div>;
}
