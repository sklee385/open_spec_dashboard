import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, X } from 'lucide-react';
import { useI18n } from '../i18n/context';
import { attentionKey, type AttentionItem, type AttentionState } from '../hooks/useAttention';
import type { Source } from '../types';
import './AttentionCenter.css';

export const AttentionContext = createContext<AttentionState | null>(null);
export function AttentionBell() {
  const model = useContext(AttentionContext), { t } = useI18n();
  if (!model) return null;
  return <button type="button" className="attention-bell" aria-label={`${t('attention.title')} ${model.items.length}`} aria-expanded={model.expanded} onClick={() => model.setExpanded(!model.expanded)}>
    <Bell size={17} aria-hidden="true" /><span>{model.items.length}</span>
  </button>;
}
export function AttentionOverlays({ sources }: { sources: Source[] }) {
  const model = useContext(AttentionContext), { t, locale } = useI18n();
  const panel = useRef<HTMLElement>(null);
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    if (!model?.expanded) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); model.setExpanded(false); previous?.focus(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [model?.expanded]);
  if (!model) return null;
  const row = (item: AttentionItem) => <button className="attention-item" key={attentionKey(item)} disabled={model.navigating} onClick={() => void model.open(item)}>
    <strong>{item.title}</strong>
    <span>{sources.find(source => source.id === item.sourceId)?.name || item.sourceId}</span>
    <span>{t(item.kind === 'input' ? 'attention.input' : 'attention.approval')}</span>
    <time dateTime={item.createdAt}>{Number.isNaN(Date.parse(item.createdAt)) ? item.createdAt : new Date(item.createdAt).toLocaleString(locale)}</time>
  </button>;
  return createPortal(<>
    {model.expanded && <section ref={panel} tabIndex={-1} className="attention-panel" role="dialog" aria-label={t('attention.title')}>
      <div className="attention-heading"><h2>{t('attention.title')} · {model.items.length}</h2><button aria-label={t('common.close')} onClick={() => model.setExpanded(false)}><X size={18} /></button></div>
      {model.connectionError && <p role="status">{t('attention.connection')}</p>}
      {model.storageError && <p role="status">{t('attention.storage')}</p>}
      {model.windowsError && <p role="status">{t('attention.windowsError')}</p>}
      {model.navigationError && <p role="alert">{t('attention.navigationError')}</p>}
      <p>{t(model.nativeSettings?.effectiveEnabled ? 'attention.granted' : model.nativeSettings?.enabled === false ? 'attention.default' : model.nativeSettings?.registrationStatus === 'unsupported' ? 'attention.unsupported' : 'attention.denied')}</p>
      <button className="attention-enable" disabled={model.savingSettings} onClick={() => void model.updateWindows({ enabled: !model.nativeSettings?.enabled })}>{t(model.nativeSettings?.enabled ? 'attention.disable' : 'attention.enable')}</button>
      <label>{t('attention.address')}<input type="url" value={address ?? model.nativeSettings?.dashboardUrl ?? ''} onChange={event => setAddress(event.target.value)} /></label>
      <button disabled={model.savingSettings || address === null} onClick={() => void model.updateWindows({ dashboardUrl: address! })}>{t('attention.saveAddress')}</button>
      <button disabled={model.savingSettings} onClick={() => void model.updateWindows({ enabled: false, unregister: true })}>{t('attention.unregister')}</button>
      <div className="attention-list">{model.items.length ? model.items.map(row) : !model.connectionError && <p>{t('attention.empty')}</p>}</div>
    </section>}
    {!!model.notices.length && <aside className="attention-notices" role="status" aria-label={t('attention.title')}>
      <div className="attention-heading"><strong>{t('attention.title')}</strong><button aria-label={t('attention.dismiss')} onClick={model.dismissNotices}><X size={18} /></button></div>
      {model.notices.slice(-3).map(row)}
    </aside>}
  </>, document.body);
}
