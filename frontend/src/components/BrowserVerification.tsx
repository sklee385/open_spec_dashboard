import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context';
import { useReadRequests } from '../hooks/useReadRequests';
import { useExactMutation } from '../hooks/useExactMutation';
import { MutationStatus } from './WorkspaceFlowShared';
import type { ExactObservation } from '../lib/exactMutation';

type Result = ExactObservation & { freshnessState?: string; targetKind?: string; candidateId?: string | null; environmentId?: string; environment?: { commit?: string }; buildAttestation?: { buildId?: string }; id: string; status: string; fresh: boolean; error?: string; image?: string; browser?: string; durationMs?: number; steps?: { index: number; op: string; status: string; durationMs: number }[] };
type Status = { live?: { id: string; candidateId?: string | null; status?: string } | null; observation?: { state: string; reason?: string }; scenario: unknown; running: boolean; busy: boolean; results: Result[] };
const example = { name: '첫 화면 확인', server: { command: 'npm', args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '14321', '--strictPort'], url: 'http://127.0.0.1:14321' }, steps: [{ op: 'goto', path: '/' }, { op: 'expectVisible', target: { role: 'heading', name: '내 앱' } }] };
type Props = { workId: string; phase: string; state: string; revision?: string; candidateId?: string; active?: boolean; canRun?: boolean; beforeRun?: () => boolean };
export function BrowserVerification(props: Props) { return <VerificationPanel key={JSON.stringify([props.workId, props.candidateId ?? null])} {...props} />; }
function VerificationPanel({ workId, phase, state, revision, candidateId, active = true, canRun = true, beforeRun }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false), [status, setStatus] = useState<Status | null>(null), [draft, setDraft] = useState(JSON.stringify(example, null, 2)), [error, setError] = useState(''), [readError, setReadError] = useState(''), [reading, setReading] = useState(false), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const loaded = useRef(false), mounted = useRef(true), pending = useRef(false);
  const endpoint = `/api/work/${encodeURIComponent(workId)}${candidateId ? `/integration/${encodeURIComponent(candidateId)}` : ''}/browser`;
  const scope = JSON.stringify(['browser', workId, candidateId ?? null]);
  const start = useExactMutation(scope + ':run'), cancel = useExactMutation(scope + ':cancel'), reconcile = useExactMutation(scope + ':reconcile');
  const { observe: observeStart } = start, { observe: observeCancel } = cancel, { observe: observeReconcile } = reconcile;
  const controlsBusy = busy || cancel.busy || reconcile.busy;
  const read = useReadRequests();
  const request = useCallback(async (suffix = '', method = 'GET', body?: unknown) => {
    const perform = async (signal?: AbortSignal) => {
      const response = await fetch(endpoint + suffix, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), ...(signal ? { signal } : {}) });
      const value = await response.json();
      if (!response.ok) throw new Error(typeof value.message === 'string' ? value.message : typeof value.error === 'string' ? value.error : t('browser.error'));
      return value;
    };
    return method === 'GET' ? read(perform) : perform();
  }, [endpoint, read, t]);
  const load = useCallback(async (inspect = false) => {
    if (pending.current) return; pending.current = true; setReading(true);
    try {
      const value = await request(inspect ? '?inspect=1' : '');
      if (!Array.isArray(value.results) || typeof value.running !== 'boolean') throw new Error(t('browser.error'));
      if (!mounted.current) return;
      setStatus(value); setReadError('');
      for (const row of value.results) { await observeStart(row); await observeCancel(row); await observeReconcile(row); }
      if (!loaded.current) { loaded.current = true; if (value.scenario) setDraft(JSON.stringify(value.scenario, null, 2)); }
    } catch (error) { if (mounted.current) setReadError(error instanceof Error ? error.message : t('browser.error')); }
    finally { pending.current = false; if (mounted.current) setReading(false); }
  }, [request, t, observeStart, observeCancel, observeReconcile]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open || !active) return;
    const initial = setTimeout(() => { void load(); }, 0); const timer = setInterval(() => { void load(); }, 2500);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [open, active, load, revision]);
  const action = async (kind: 'save' | 'run' | 'cancel' | 'reconcile') => {
    if (controlsBusy || kind === 'run' && (start.busy || !canRun || beforeRun?.() === false) || kind === 'save' && candidateId) return;
    if (kind !== 'save') {
      if ((kind === 'cancel' || kind === 'reconcile') && candidateId && !status?.live?.id || kind === 'reconcile' && !status?.live?.id) return;
      const mutation = kind === 'run' ? start : kind === 'cancel' ? cancel : reconcile;
      const body = kind === 'run' ? { requestKey: crypto.randomUUID() } : kind === 'reconcile' ? { runId: status!.live!.id, confirmed: true } : status?.live?.id ? { runId: status.live.id } : {};
      if (await mutation.run(endpoint + '/' + kind, body)) await load(); return;
    }
    let value; try { value = JSON.parse(draft); } catch { setError(t('browser.invalid')); return; }
    setBusy(true); setError('');
    try { await request('/scenario', 'PUT', value); if (mounted.current) { setDirty(false); await load(); } }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : t('browser.error')); }
    finally { if (mounted.current) setBusy(false); }
  };
  const labels: Record<string, string> = { passed: t('browser.passed'), failed: t('browser.failed'), blocked: t('browser.blocked'), interrupted: t('browser.interrupted'), running: t('browser.running'), stale: t('browser.stale') };
  const editable = ['implementation', 'verification'].includes(phase) && ['idle', 'interrupted', 'failed'].includes(state) && !status?.busy;
  return <details className="shrink-0 border-b p-3 text-sm max-h-[55vh] overflow-auto" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">{t(candidateId ? 'browser.candidateTitle' : 'browser.title')}</summary>
    {open && <div className="space-y-2 py-2">
      <p>{t('browser.hint')}</p>
      {error && <p role="alert">{error}</p>}{readError && <p role="alert">{readError}</p>}
      {!status && !error && <p role="status">{t('browser.loading')}</p>}
      {!['implementation', 'verification'].includes(phase) && <p>{t('browser.phase')}</p>}
      {!candidateId ? <label className="block">{t('browser.json')}<textarea aria-label={t('browser.json')} rows={10} className="block w-full border rounded p-2 font-mono text-xs" value={draft} disabled={!editable || controlsBusy || start.busy} onChange={event => { setDraft(event.target.value); setDirty(true); }} /></label> : <p>{t('browser.candidateScenario')}</p>}
      {dirty && <p>{t('browser.unsaved')}</p>}
      <div className="flex flex-wrap gap-2">
        {!candidateId && <button disabled={!editable || busy} onClick={() => void action('save')}>{t('browser.save')}</button>}
        <button disabled={!editable || controlsBusy || start.busy || start.receipt?.state === 'uncertain' || dirty || !status?.scenario || !canRun} onClick={() => void action('run')}>{t(candidateId ? 'browser.candidateRun' : 'browser.run')}</button>
        {status?.running && <button disabled={controlsBusy || !!candidateId && !status.live?.id} onClick={() => void action('cancel')}>{t(candidateId ? 'browser.candidateCancel' : 'browser.cancel')}</button>}
        {status?.live?.status === 'unknown' && (status.live.candidateId ?? null) === (candidateId ?? null) && <button disabled={controlsBusy} onClick={() => void action('reconcile')}>{t('browser.reconcile')}</button>}
        <button disabled={reading} onClick={() => void load()}>{t('browser.refresh')}</button><button disabled={reading} onClick={() => void load(true)}>{t('browser.inspect')}</button>
      </div>
      {status?.live?.status === 'unknown' && <p>{t('browser.reconcileHint')}</p>}
      <MutationStatus {...start} retry={() => { if (canRun && beforeRun?.() !== false) void start.run().then(ok => { if (ok) void load(); }); }} />
      <MutationStatus {...cancel} retry={() => void cancel.run().then(ok => { if (ok) void load(); })} />
      <MutationStatus {...reconcile} retry={() => void reconcile.run().then(ok => { if (ok) void load(); })} />
      {status?.observation?.reason && <p>{status.observation.reason}</p>}{status && !status.results.length && <p>{t('browser.empty')}</p>}
      {status?.results.slice().reverse().map(row => <details key={row.id}>
        <summary>{labels[row.status] || row.status}{row.status !== 'running' ? ` · ${t(row.freshnessState === 'not-checked' ? 'browser.notChecked' : row.fresh ? 'browser.fresh' : 'browser.stale')}` : ''}{row.durationMs ? ` · ${(row.durationMs / 1000).toFixed(1)}s` : ''}</summary>
        <dl><dt>{t('browser.target')}</dt><dd>{t(row.targetKind === 'integration-candidate' ? 'browser.candidate' : 'browser.work')}{row.candidateId ? ` · ${row.candidateId}` : ''}</dd>
          <dt>{t('browser.environment')}</dt><dd>{row.environmentId ?? '—'}</dd><dt>{t('browser.build')}</dt><dd>{row.buildAttestation?.buildId ?? '—'}</dd><dt>{t('browser.executedCommit')}</dt><dd>{row.environment?.commit ?? '—'}</dd></dl>
        {row.error && <p>{row.error}</p>}{row.browser && <p>{row.browser}</p>}
        <ol>{row.steps?.map(step => <li key={step.index}>{step.index + 1}. {step.op} · {labels[step.status] || step.status}</li>)}</ol>
        {row.image?.startsWith('data:image/jpeg;base64,') && <img className="max-w-full" src={row.image} alt={t('browser.image')} />}
      </details>)}
    </div>}
  </details>;
}
