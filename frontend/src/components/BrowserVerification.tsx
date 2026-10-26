import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context';

type Result = { id: string; status: string; fresh: boolean; error?: string; image?: string; browser?: string; durationMs?: number; steps?: { index: number; op: string; status: string; durationMs: number }[] };
type Status = { scenario: unknown; running: boolean; busy: boolean; results: Result[] };
const example = { name: '첫 화면 확인', server: { command: 'npm', args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '14321', '--strictPort'], url: 'http://127.0.0.1:14321' }, steps: [{ op: 'goto', path: '/' }, { op: 'expectVisible', target: { role: 'heading', name: '내 앱' } }] };
export function BrowserVerification({ workId, phase, state, revision }: { workId: string; phase: string; state: string; revision?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false), [status, setStatus] = useState<Status | null>(null), [draft, setDraft] = useState(JSON.stringify(example, null, 2)), [error, setError] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const loaded = useRef(false), mounted = useRef(true), pending = useRef(false);
  const endpoint = `/api/work/${encodeURIComponent(workId)}/browser`;
  const request = useCallback(async (suffix = '', method = 'GET', body?: unknown) => {
    const response = await fetch(endpoint + suffix, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.message === 'string' ? value.message : typeof value.error === 'string' ? value.error : t('browser.error'));
    return value;
  }, [endpoint, t]);
  const load = useCallback(async () => {
    if (pending.current) return; pending.current = true;
    try {
      const value = await request();
      if (!Array.isArray(value.results) || typeof value.running !== 'boolean') throw new Error(t('browser.error'));
      if (!mounted.current) return;
      setStatus(value); setError('');
      if (!loaded.current) { loaded.current = true; if (value.scenario) setDraft(JSON.stringify(value.scenario, null, 2)); }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : t('browser.error')); }
    finally { pending.current = false; }
  }, [request, t]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    void load(); const timer = setInterval(() => { void load(); }, 2500);
    return () => clearInterval(timer);
  }, [open, load, revision]);
  const action = async (kind: 'save' | 'run' | 'cancel') => {
    if (busy) return; let value;
    if (kind === 'save') { try { value = JSON.parse(draft); } catch { setError(t('browser.invalid')); return; } }
    setBusy(true); setError('');
    try { await request(kind === 'save' ? '/scenario' : `/${kind}`, kind === 'save' ? 'PUT' : 'POST', value); if (mounted.current) { if (kind === 'save') setDirty(false); await load(); } }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : t('browser.error')); }
    finally { if (mounted.current) setBusy(false); }
  };
  const labels: Record<string, string> = { passed: t('browser.passed'), failed: t('browser.failed'), blocked: t('browser.blocked'), interrupted: t('browser.interrupted'), running: t('browser.running'), stale: t('browser.stale') };
  const editable = ['implementation', 'verification'].includes(phase) && ['idle', 'interrupted', 'failed'].includes(state) && !status?.busy;
  return <details className="shrink-0 border-b p-3 text-sm max-h-[55vh] overflow-auto" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">{t('browser.title')}</summary>
    {open && <div className="space-y-2 py-2">
      <p>{t('browser.hint')}</p>
      {error && <p role="alert">{error}</p>}
      {!status && !error && <p role="status">{t('browser.loading')}</p>}
      {!['implementation', 'verification'].includes(phase) && <p>{t('browser.phase')}</p>}
      <label className="block">{t('browser.json')}<textarea aria-label={t('browser.json')} rows={10} className="block w-full border rounded p-2 font-mono text-xs" value={draft} disabled={!editable || busy} onChange={event => { setDraft(event.target.value); setDirty(true); }} /></label>
      {dirty && <p>{t('browser.unsaved')}</p>}
      <div className="flex flex-wrap gap-2">
        <button disabled={!editable || busy} onClick={() => void action('save')}>{t('browser.save')}</button>
        <button disabled={!editable || busy || dirty || !status?.scenario} onClick={() => void action('run')}>{t('browser.run')}</button>
        {status?.running && <button disabled={busy} onClick={() => void action('cancel')}>{t('browser.cancel')}</button>}
        <button disabled={busy} onClick={() => void load()}>{t('browser.refresh')}</button>
      </div>
      {status && !status.results.length && <p>{t('browser.empty')}</p>}
      {status?.results.slice().reverse().map(row => <details key={row.id}>
        <summary>{labels[row.status] || row.status}{!row.fresh && row.status !== 'running' ? ` · ${t('browser.stale')}` : ''}{row.durationMs ? ` · ${(row.durationMs / 1000).toFixed(1)}s` : ''}</summary>
        {row.error && <p>{row.error}</p>}{row.browser && <p>{row.browser}</p>}
        <ol>{row.steps?.map(step => <li key={step.index}>{step.index + 1}. {step.op} · {labels[step.status] || step.status}</li>)}</ol>
        {row.image?.startsWith('data:image/jpeg;base64,') && <img className="max-w-full" src={row.image} alt={t('browser.image')} />}
      </details>)}
    </div>}
  </details>;
}
