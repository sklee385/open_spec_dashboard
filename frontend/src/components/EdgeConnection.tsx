import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context';

type Status = { supported: boolean; connected: boolean; title?: string; url?: string };
type Pair = { endpoint: string; code: string; expiresAt: string };
async function request(path: string, method = 'GET') {
  const response = await fetch(path, { method }); const value = await response.json();
  if (!response.ok) throw new Error(typeof value.message === 'string' ? value.message : typeof value.error === 'string' ? value.error : '');
  return value;
}
export function EdgeConnection({ workId }: { workId?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false), [status, setStatus] = useState<Status | null>(null), [extensionPath, setExtensionPath] = useState('');
  const [pair, setPair] = useState<Pair | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now());
  const sequence = useRef(0), mounted = useRef(true);
  const endpoint = workId ? `/api/work/${encodeURIComponent(workId)}/browser/edge` : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++sequence.current; }; }, []);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const [settings, connection] = await Promise.all([request('/api/browser/edge/status'), endpoint ? request(endpoint) : Promise.resolve(null)]);
      if (typeof settings.extensionPath !== 'string' || !Array.isArray(settings.connections) || (connection && (typeof connection.supported !== 'boolean' || typeof connection.connected !== 'boolean'))) throw new Error('');
      if (current !== sequence.current || !mounted.current) return;
      setExtensionPath(settings.extensionPath); setStatus(connection); setError(''); setNow(Date.now());
      if (connection?.connected) setPair(null);
    } catch (error) { if (current === sequence.current && mounted.current) setError(error instanceof Error && error.message ? error.message : t('edge.error')); }
  }, [endpoint, t]);
  useEffect(() => {
    setStatus(null); setPair(null); setExtensionPath(''); setError('');
    if (!open) return;
    void load(); const timer = setInterval(() => { void load(); }, 5000);
    return () => { ++sequence.current; clearInterval(timer); };
  }, [open, load]);
  const action = async (operation: 'pair' | 'disconnect') => {
    if (!endpoint || busy) return;
    setBusy(true); setError(''); ++sequence.current;
    try {
      if (operation === 'pair') {
        const value = await request(endpoint + '/pair', 'POST');
        if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(value.endpoint) || typeof value.code !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('');
        if (mounted.current) { setPair(value); setNow(Date.now()); }
      } else { await request(endpoint, 'DELETE'); if (mounted.current) { setPair(null); setStatus(old => old ? { ...old, connected: false } : old); } }
    } catch (error) { if (mounted.current) setError(error instanceof Error && error.message ? error.message : t('edge.error')); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <details className="shrink-0 border-b p-3 text-sm max-h-[45vh] overflow-auto" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">{t('edge.title')}</summary>
    {open && <div className="space-y-2 py-2">
      {error && <p role="alert">{error}</p>}
      {!extensionPath && !error && <p role="status">{t('edge.loading')}</p>}
      {extensionPath && <><p>{t('edge.install')}</p><code className="block break-all select-all">{extensionPath}</code><p>{t('edge.workHint')}</p></>}
      {status && (!status.supported ? <p>{t('edge.legacy')}</p> : <>
        <p role="status">{status.connected ? t('edge.connected') : t('edge.disconnected')}</p>
        {status.connected && <><p>{status.title}</p><p className="break-all">{status.url}</p><button disabled={busy} onClick={() => void action('disconnect')}>{t('edge.disconnect')}</button></>}
        {!status.connected && <button disabled={busy} onClick={() => void action('pair')}>{t('edge.pair')}</button>}
      </>)}
      {pair && (Date.parse(pair.expiresAt) <= now ? <p role="status">{t('edge.expired')}</p> : <div className="space-y-1 border rounded p-2">
        <p>{t('edge.codeHint')}</p><p>{t('edge.endpoint')}</p><code className="block break-all select-all">{pair.endpoint}</code>
        <p>{t('edge.code')}</p><code className="block select-all">{pair.code}</code><p>{t('edge.expires')} · {new Date(pair.expiresAt).toLocaleTimeString()}</p>
      </div>)}
      <p>{t('edge.scope')}</p><button disabled={busy} onClick={() => void load()}>{t('edge.refresh')}</button>
    </div>}
  </details>;
}
