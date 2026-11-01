import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/context';

type State = 'automatic' | 'active' | 'completed' | 'archived';
type Receipt = { id: string; before: State; after: State; at: string; reason: string; scope: string; runId: string | null };
type Status = { workId: string; sourceId: string; changeName: string; scope: 'work' | 'run'; runId: string | null; state: State; version: number; observation: string; observed: { phase: string; state: string; runtime: string }; history: Receipt[] };
type Submission = { scope: string; runId: string | null; state: State; expectedVersion: number; observation: string; reason: string; requestKey: string };

export function WorkManagement({ workId, initiallyOpen = false }: { workId: string; initiallyOpen?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(initiallyOpen);
  const [scope, setScope] = useState<'work' | 'run'>('work'), [status, setStatus] = useState<Status | null>(null);
  const [state, setState] = useState<State>('completed'), [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const submitting = useRef(false), pending = useRef<Submission | null>(null), live = useRef(true);
  const currentScope = useRef(scope); currentScope.current = scope;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const labels: Record<State, string> = { automatic: t('management.automatic'), active: t('management.active'), completed: t('management.completed'), archived: t('management.archived') };
  const load = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(`/api/work/${encodeURIComponent(workId)}/management?scope=${scope}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
    const data = await res.json(); if (!res.ok) throw Error(data.message || t('workRoom.noResponse'));
    if (data.workId !== workId || !data.observed || !Array.isArray(data.history) || !['automatic', 'active', 'completed', 'archived'].includes(data.state)) throw Error(t('workRoom.noResponse'));
    if (live.current && currentScope.current === scope && !signal?.aborted) setStatus(data);
  }, [workId, scope, t]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setStatus(null); setError('');
    void load(controller.signal).catch(e => { if (!controller.signal.aborted) setError(String(e.message)); });
    return () => { controller.abort(); };
  }, [load, open]);
  const submit = async () => {
    if (!status || submitting.current || (!pending.current && reason.trim().length < 2)) return;
    const body = pending.current ?? { scope, runId: status.runId, state, expectedVersion: status.version, observation: status.observation, reason: reason.trim(), requestKey: crypto.randomUUID() };
    pending.current = body; submitting.current = true; setBusy(true); setError('');
    try {
      const response = await fetch(`/api/work/${encodeURIComponent(workId)}/management`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) { pending.current = null; if (live.current) setUncertain(false); await load(); }
        throw Error(data.message || t('workRoom.noResponse'));
      }
      pending.current = null;
      if (live.current) { setStatus(data); setReason(''); setUncertain(false); }
    } catch (e) {
      if (live.current) { setError(e instanceof Error ? e.message : t('workRoom.noResponse')); setUncertain(!!pending.current); }
    } finally { submitting.current = false; if (live.current) setBusy(false); }
  };
  return <details className="work-management" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{t('management.title')}</summary>
    <p>{t('management.hint')}</p>
    <p>{t('management.workId')}: <code>{workId}</code></p>
    {status && <><p>{status.sourceId} / {status.changeName}</p><p>{t('management.observed')}: {status.observed.phase} / {status.observed.state} · {t('management.runtime')}: {status.observed.runtime}</p><p>{t('management.runId')}: <code>{status.runId || t('common.none')}</code></p><p role="status">{t('management.current')}: {labels[status.state]}</p></>}
    {error && <p role="alert">{error}</p>}
    {uncertain && <p role="status">{t('management.uncertain')}</p>}
    <label>{t('management.scope')}<select aria-label={t('management.scope')} value={scope} disabled={busy || uncertain} onChange={e => setScope(e.target.value as 'work' | 'run')}><option value="work">{t('management.workScope')}</option><option value="run">{t('management.runScope')}</option></select></label>
    <label>{t('management.next')}<select aria-label={t('management.next')} value={state} disabled={busy || uncertain} onChange={e => setState(e.target.value as State)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value} disabled={value === 'archived' && status?.state !== 'completed'}>{label}</option>)}</select></label>
    <label>{t('management.reason')}<input aria-label={t('management.reason')} maxLength={500} value={reason} disabled={busy || uncertain} onChange={e => setReason(e.target.value)} /></label>
    <button disabled={busy || !status || (!uncertain && (reason.trim().length < 2 || state === status.state))} onClick={() => void submit()}>{busy ? t('management.saving') : uncertain ? t('management.retry') : t('management.apply')}</button>
    <button disabled={busy || uncertain} onClick={() => void load().catch(e => setError(e.message))}>{t('workRoom.refreshState')}</button>
    <h3>{t('management.history')}</h3><ol>{status?.history.map(row => <li key={row.id}><time dateTime={row.at}>{row.at}</time> · {labels[row.before]} → {labels[row.after]} · {row.scope} / {row.runId || t('common.none')}<p>{row.reason}</p></li>)}</ol>
  </details>;
}
