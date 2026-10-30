import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/context';
import { WorkspaceMaintenance } from './WorkspaceMaintenance';

interface Settings {
  version: number; profileId: string; path: string | null; managedPath: string | null;
  source: 'environment' | 'saved' | 'unset'; editable: boolean; confirmed: boolean;
  available: boolean; freeBytes: number | null; error?: string;
  policy?: { maxActiveWorks: number; minimumFreeBytes: number; retentionDays: number };
}
interface Check { token: string; version: number; path: string; managedPath: string; }
declare global { interface Window { desktopWorkspace?: { chooseFolder(): Promise<{ cancelled: boolean; path?: string }> }; } }
export function WorkspaceSettings() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(null), [path, setPath] = useState('');
  const [check, setCheck] = useState<Check | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const [policy, setPolicy] = useState({ maxActiveWorks: '3', minimumFreeGiB: '5', retentionDays: '14' });
  async function request(method = 'GET', suffix = '', body?: unknown) {
    const response = await fetch(`/api/workspace-settings${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || t('workspace.error'));
    return data;
  }
  function invalidate() { setCheck(null); setConfirmed(false); setSaved(false); setError(''); }
  async function load(keepDraft: boolean) {
    setBusy(true); invalidate();
    try { const next = await request(); setSettings(next); if (!keepDraft) { setPath(next.path || ''); if (next.policy) setPolicy({ maxActiveWorks: String(next.policy.maxActiveWorks), minimumFreeGiB: String(next.policy.minimumFreeBytes / 1024 ** 3), retentionDays: String(next.policy.retentionDays) }); } }
    catch (e) { setError(e instanceof Error ? e.message : t('workspace.loadError')); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(false); }, []);
  async function inspect() {
    setBusy(true); invalidate();
    try { setCheck(await request('POST', '/check', { path, version: settings!.version })); }
    catch (e) { setError(e instanceof Error ? e.message : t('workspace.error')); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!check || !confirmed) return;
    setBusy(true); setError('');
    try {
      const next = await request('PUT', '', { token: check.token, version: check.version, confirmed: true });
      setSettings(next); setPath(next.path || ''); invalidate(); setSaved(true);
    } catch (e) { setCheck(null); setConfirmed(false); setError(e instanceof Error ? e.message : t('workspace.error')); }
    finally { setBusy(false); }
  }
  async function chooseFolder() {
    if (!window.desktopWorkspace) return;
    setBusy(true); setError('');
    try {
      const result = await window.desktopWorkspace.chooseFolder();
      if (!result.cancelled && result.path) { setPath(result.path); invalidate(); }
    } catch { setError(t('workspace.pickError')); }
    finally { setBusy(false); }
  }
  const values = { maxActiveWorks: Number(policy.maxActiveWorks), minimumFreeBytes: Math.round(Number(policy.minimumFreeGiB) * 1024 ** 3), retentionDays: Number(policy.retentionDays) };
  const validPolicy = Object.values(policy).every(value => value.trim() !== '') && Number.isSafeInteger(values.maxActiveWorks) && values.maxActiveWorks >= 1 && Number.isSafeInteger(values.minimumFreeBytes) && values.minimumFreeBytes >= 0 && Number.isSafeInteger(values.retentionDays) && values.retentionDays >= 1;
  async function savePolicy() {
    if (!validPolicy || !settings) return;
    setBusy(true); invalidate();
    try { const next = await request('PUT', '/policy', { version: settings.version, policy: values }); setSettings(next); }
    catch (e) { setError(e instanceof Error ? e.message : t('workspace.error')); }
    finally { setBusy(false); }
  }
  const inputClass = 'block w-full rounded border bg-background p-2 text-sm';
  return <section className="space-y-3 border-t pt-4" aria-label={t('workspace.title')}>
    <h3>{t('workspace.title')}</h3>
    <p className="text-sm text-muted-foreground">{t('workspace.hint')}</p>
    {error && <p role="alert">{error}</p>}{saved && <p role="status">{t('workspace.saved')}</p>}
    {settings && <>
      <dl className="space-y-1 text-sm">
        <div><dt className="inline text-muted-foreground">{t('workspace.source')}: </dt><dd className="inline">{t(settings.source === 'environment' ? 'workspace.environment' : settings.source === 'saved' ? 'workspace.savedSource' : 'workspace.unset')}</dd></div>
        <div><dt className="text-muted-foreground">{t('workspace.current')}</dt><dd className="break-all">{settings.path || t('workspace.unset')}</dd></div>
        <div><dt className="inline text-muted-foreground">{t('workspace.free')}: </dt><dd className="inline tabular-nums">{settings.freeBytes == null ? t('workspace.unknown') : `${(settings.freeBytes / 1024 ** 3).toFixed(1)} GiB`}</dd></div>
      </dl>
      <p className="text-sm">{settings.confirmed ? t(settings.available ? 'workspace.available' : 'workspace.unavailable') : t('workspace.unconfirmed')}</p>
      {settings.error && <p className="text-sm">{settings.error}</p>}
      <label className="block text-sm">{t('workspace.path')}<input className={inputClass} value={path} disabled={busy || settings.editable === false} onChange={e => { setPath(e.target.value); invalidate(); }} /></label>
      {window.desktopWorkspace && settings.editable !== false && <button type="button" className="rounded border px-3 py-2 text-sm disabled:opacity-50" disabled={busy} onClick={() => void chooseFolder()}>{t('workspace.pick')}</button>}
      <button type="button" className="rounded border px-3 py-2 text-sm disabled:opacity-50" disabled={busy || !path} onClick={() => void inspect()}>{t('workspace.check')}</button>
      {check && <div className="space-y-2 rounded border p-3 text-sm">
        <p role="status">{t('workspace.checked')}</p>
        <p>{t('workspace.managed')}</p><p className="break-all">{check.managedPath}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />{t('workspace.confirm')}</label>
      </div>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded border px-3 py-2 text-sm disabled:opacity-50" disabled={busy || !check || !confirmed} onClick={() => void save()}>{t('workspace.save')}</button>
        <button type="button" className="px-2 py-2 text-sm underline disabled:opacity-50" disabled={busy} onClick={() => void load(true)}>{t('workspace.reload')}</button>
      </div>
      <fieldset className="space-y-3 border-t pt-3" disabled={busy}>
        <legend className="text-sm">{t('workspace.policy')}</legend>
        <label className="block text-sm">{t('workspace.maxActive')}<input type="number" min="1" step="1" className={inputClass} value={policy.maxActiveWorks} onChange={e => setPolicy({ ...policy, maxActiveWorks: e.target.value })} /></label>
        <label className="block text-sm">{t('workspace.minimumFree')}<input type="number" min="0" step="any" className={inputClass} value={policy.minimumFreeGiB} onChange={e => setPolicy({ ...policy, minimumFreeGiB: e.target.value })} /></label>
        <label className="block text-sm">{t('workspace.retention')}<input type="number" min="1" step="1" className={inputClass} value={policy.retentionDays} onChange={e => setPolicy({ ...policy, retentionDays: e.target.value })} /></label>
        <p className="text-sm text-muted-foreground">{t('workspace.policyHint')}</p>
        <button type="button" className="rounded border px-3 py-2 text-sm disabled:opacity-50" disabled={busy || !validPolicy} onClick={() => void savePolicy()}>{t('workspace.savePolicy')}</button>
      </fieldset>
    </>}
    <WorkspaceMaintenance />
  </section>;
}
