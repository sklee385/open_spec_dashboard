import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context';
import { flowGet } from '../lib/workspaceFlowApi';
import { useExactMutation } from '../hooks/useExactMutation';
import { useCoalescedRefresh } from '../hooks/useCoalescedRefresh';
import { useReadRequests } from '../hooks/useReadRequests';
import { draftStorage } from '../lib/draftStorage';
import { projectDraftKey, readDocumentDraft } from '../hooks/useLocalDraft';
import type { CandidateApplyStatus, CandidateRun, CandidateVerification, IntegrationRequest } from '../types/workspaceFlow';
import { MutationStatus } from './WorkspaceFlowShared';
type Props = { workId: string; candidate: IntegrationRequest; active?: boolean; workDirty?: boolean; sourceId?: string; onChanged?: () => void };
export function CandidateLifecycle(props: Props) { return <LifecycleContent key={JSON.stringify([props.workId, props.candidate.candidateId, props.candidate.candidateCommit ?? null, props.candidate.candidateMutationVersion ?? null])} {...props} />; }
function LifecycleContent({ workId, candidate, active = true, workDirty = false, sourceId, onChanged }: Props) {
  const { t } = useI18n(), cid = candidate.candidateId, base = `/api/work/${encodeURIComponent(workId)}/integration/${encodeURIComponent(cid)}`, scope = `${workId}:${cid}`;
  const [status, setStatus] = useState<CandidateApplyStatus | null>(null), [verification, setVerification] = useState<CandidateVerification | null>(null), [expectedVersion, setExpectedVersion] = useState('');
  const [confirmRun, setConfirmRun] = useState(false), [confirmApply, setConfirmApply] = useState(false), [confirmCancel, setConfirmCancel] = useState(false), [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState(''), [verifyError, setVerifyError] = useState(''), [guardError, setGuardError] = useState(''); const generation = useRef(0);
  const run = useExactMutation(`verification-run:${scope}`), apply = useExactMutation(`candidate-apply:${scope}`), cancel = useExactMutation(`candidate-cancel:${scope}`);
  const savedKey = status?.receipt?.requestKey ?? (typeof apply.receipt?.body.requestKey === 'string' ? apply.receipt.body.requestKey : '');
  const reconcile = useExactMutation(`candidate-apply-reconcile:${scope}:${savedKey}`);
  const observeRun = run.observe;
  const labels: Record<string, string> = { applied: t('life.applied'), cancelled: t('life.cancelled'), uncertain: t('life.uncertain'), 'not-checked': t('life.notChecked'), active: t('life.active'), unknown: t('life.unknown'), settled: t('life.settled'), passed: t('life.passed'), failed: t('life.failed'), stale: t('life.stale'), running: t('life.active') };
  const label = (value: string) => labels[value] ?? value;
  const read = useReadRequests(); const get = useCallback(<T,>(endpoint: string) => read(signal => flowGet<T>(endpoint, signal)), [read]);
  const loadStatus = useCoalescedRefresh(async (inspect = false) => {
    const gen = generation.current;
    try { const next = await get<CandidateApplyStatus>(`${base}/apply/status${inspect ? '?inspect=1' : ''}`); if (gen === generation.current) { if (!next || next.candidateId !== cid || !Array.isArray(next.receipts) || !next.live || !['active', 'unknown', 'settled'].includes(next.live.state) || !next.observation || typeof next.observation.state !== 'string') throw new Error(t('life.invalidStatus')); setStatus(next); setReadError(''); for (const row of next.receipts) { await apply.observe(row, next.live.state); await reconcile.observe(row, next.live.state); } } }
    catch (error) { if (gen === generation.current) setReadError(error instanceof Error ? error.message : String(error)); }
  });
  // Only the cheap, non-inspecting status endpoint is polled while visible.
  useEffect(() => {
    if (!active) return;
    // A read invalidated while hidden must not keep this view locked on return.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(false);
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    void loadStatus(); const poll = async () => { if (document.visibilityState !== 'hidden') await loadStatus(); if (!stopped) timer = setTimeout(poll, 10000); }; timer = setTimeout(poll, 10000);
    return () => { stopped = true; generation.current++; clearTimeout(timer); };
  }, [active, loadStatus]);
  // A different candidate commit cannot inherit a previous preview or confirmation.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setVerification(null); setExpectedVersion(''); setConfirmRun(false); setConfirmApply(false); }, [candidate.candidateCommit]);
  const inspectVerification = useCallback(async () => {
    const gen = generation.current; setLoading(true); setVerifyError(''); setConfirmRun(false); setExpectedVersion(''); setConfirmApply(false);
    try {
      const results = await get<CandidateVerification>(`${base}/verification/results`); if (gen !== generation.current) return; setVerification(results); for (const row of results.runs) await observeRun(row);
      if (['validating', 'ready'].includes(candidate.status)) { const preview = await get<CandidateVerification>(`${base}/verification/preview`); if (gen === generation.current) setVerification(preview); }
    } catch (error) { if (gen === generation.current) setVerifyError(String(error)); } finally { if (gen === generation.current) setLoading(false); }
  }, [base, candidate.status, get, observeRun]);
  const guarded = () => {
    try {
      if (workDirty) throw new Error(t('life.unsaved'));
      if (sourceId) { const view = JSON.parse(draftStorage.getItem(`project-view:${JSON.stringify([sourceId, workId, cid])}`) ?? 'null'); if (view?.path && readDocumentDraft(projectDraftKey(sourceId, workId, view.path, cid))) throw new Error(t('life.unsaved')); }
      setGuardError(''); return true;
    } catch (error) { setGuardError(error instanceof Error ? error.message : String(error)); return false; }
  };
  const applied = candidate.status === 'applied' || status?.receipt?.status === 'applied', cancelled = candidate.status === 'cancelled';
  const busy = loading || run.busy || apply.busy || reconcile.busy || cancel.busy;
  const running = verification?.runs.some(row => row.status === 'running') ?? false;
  const unknown = !status || !!readError || status.live.state !== 'settled';
  const ready = verification?.ready === true;
  const applyBlocked = busy || workDirty || applied || cancelled || unknown || running || apply.receipt?.state === 'uncertain';
  const preflight = async () => {
    if (!guarded()) return; const gen = generation.current; setLoading(true); setExpectedVersion(''); setConfirmApply(false);
    try { const next = await get<{ expectedVersion: string }>(`${base}/apply/preview`); if (gen === generation.current) { setExpectedVersion(next.expectedVersion); setReadError(''); } }
    catch (error) { if (gen === generation.current) setReadError(error instanceof Error ? error.message : String(error)); } finally { if (gen === generation.current) setLoading(false); }
  };
  const changed = async () => { await loadStatus(); onChanged?.(); };
  return <section className="workspace-flow" aria-label={t('life.title')}><h3>{t('life.title')}</h3><p>{t('life.separate')}</p>
    <dl><dt>{t('flow.target')}</dt><dd>{candidate.targetBranch} · {candidate.targetHead}</dd><dt>{t('flow.integration')}</dt><dd>{candidate.candidateCommit ?? '—'}</dd><dt>{t('flow.path')}</dt><dd>{candidate.executionPath}</dd></dl>
    {loading && <p role="status">{t('flow.loading')}</p>}{[readError, verifyError, guardError].filter(Boolean).map((error, index) => <p role="alert" key={index}>{error}</p>)}{workDirty && <p role="status">{t('life.unsaved')}</p>}
    <button disabled={loading} onClick={() => void inspectVerification()}>{t('life.verifyInspect')}</button>
    {verification && <><p>{t(verification.cliPassed ? 'life.cliPassed' : 'life.cliMissing')}</p>{verification.browserRequired && <p>{t('life.browserRequired')}</p>}<p>{t(verification.ready ? 'life.ready' : 'life.notReady')}</p>{verification.error && <p role="status">{verification.error}</p>}
      <ul>{verification.commands?.map(command => <li key={command.id}>{command.id}: <code>{command.command}</code><ol>{command.args.map((arg, index) => <li key={index}>{arg}</li>)}</ol></li>)}</ul></>}
    <label><input type="checkbox" checked={confirmRun} disabled={busy || workDirty || running} onChange={event => setConfirmRun(event.target.checked)} />{t('life.confirmRun')}</label>
    <button disabled={busy || workDirty || !confirmRun || !verification?.candidateVersion || running || applied || cancelled || unknown || run.receipt?.state === 'uncertain'} onClick={() => { if (guarded()) void run.run(`${base}/verification/run`, { requestKey: crypto.randomUUID(), confirmed: true, candidateVersion: verification!.candidateVersion }).then(ok => { if (ok) { setConfirmRun(false); void inspectVerification(); } }); }}>{t('life.run')}</button>
    <MutationStatus {...run} retry={() => { if (guarded()) void run.run().then(ok => { if (ok) void inspectVerification(); }); }} />
    {verification?.runs.length ? <details open><summary>{t('life.runHistory')}</summary>{verification.runs.map(row => <section key={row.id}><p>{row.id}: {label(row.status)} · {t(row.fresh ? 'life.fresh' : 'life.stale')}</p>{row.error && <p>{row.error}</p>}{row.commands?.map((command, index) => <details key={index}><summary>{command.id ?? command.command} · {label(command.status)}</summary><pre>{command.stdout ?? command.output}{command.stderr}</pre></details>)}<RunControls workId={workId} candidateId={cid} run={row} onChanged={inspectVerification} /></section>)}</details> : null}
    <button disabled={applyBlocked || !ready} onClick={() => void preflight()}>{t('life.preflight')}</button>{expectedVersion && <p role="status">{t('life.preflightPassed')}</p>}
    <label><input type="checkbox" disabled={applyBlocked || !expectedVersion || !ready} checked={confirmApply} onChange={event => setConfirmApply(event.target.checked)} />{t('life.confirmApply')}</label>
    <button disabled={applyBlocked || !ready || !expectedVersion || !confirmApply} onClick={() => { if (guarded()) void apply.run(`${base}/apply`, { requestKey: crypto.randomUUID(), confirmed: true, expectedVersion }).then(ok => { if (ok) { setConfirmApply(false); setExpectedVersion(''); void changed(); } }); }}>{t('life.apply')}</button>
    <MutationStatus {...apply} retry={() => { if (guarded()) void apply.run().then(ok => { if (ok) void changed(); }); }} />
    <h4>{t('life.receipts')}</h4>{status?.receipts.map((row, index) => <p key={`${row.requestKey}:${index}`}><code>{row.requestKey}</code>: {label(row.status)} · {row.appliedCommit ?? row.observedHead} {row.endedAt ?? row.createdAt} {row.error}</p>)}
    <h4>{t('life.current')}</h4><p>{label(status?.observation.state ?? 'not-checked')} {status?.observation.head} {status?.observation.reason}</p><p>{t('life.live')}: {label(status?.live.state ?? 'unknown')} {status?.live.reason}</p>
    {status?.observation.last && <details open><summary>{t('life.previous')}</summary><p>{label(status.observation.last.state)} {status.observation.last.head} {status.observation.last.reason}</p></details>}
    <button disabled={loading} onClick={() => void loadStatus(true)}>{t('life.inspect')}</button>
    {savedKey && <button disabled={busy || status?.live.state === 'active'} onClick={() => void reconcile.run(`${base}/apply/reconcile`, { requestKey: savedKey, confirmed: true }).then(ok => { if (ok) void changed(); })}>{t('life.reconcile')}</button>}
    <MutationStatus {...reconcile} retry={() => void reconcile.run().then(ok => { if (ok) void changed(); })} />
    <p>{t('life.cancelHint')}</p><label><input type="checkbox" checked={confirmCancel} disabled={busy || applied || cancelled || unknown || running} onChange={event => setConfirmCancel(event.target.checked)} />{t('life.cancelConfirm')}</label>
    <button disabled={busy || !confirmCancel || applied || cancelled || unknown || running || cancel.receipt?.state === 'uncertain'} onClick={() => void cancel.run(`${base}/cancel`, { confirmed: true }).then(ok => { if (ok) { setConfirmCancel(false); void changed(); } })}>{t('life.cancel')}</button>
    <MutationStatus {...cancel} retry={() => void cancel.run().then(ok => { if (ok) void changed(); })} />
  </section>;
}
function RunControls({ workId, candidateId, run, onChanged }: { workId: string; candidateId: string; run: CandidateRun; onChanged: () => Promise<void> }) {
  const { t } = useI18n(), base = `/api/work/${encodeURIComponent(workId)}/integration/${encodeURIComponent(candidateId)}/verification`;
  const cancel = useExactMutation(`verification-cancel:${workId}:${candidateId}:${run.id}`), reconcile = useExactMutation(`verification-reconcile:${workId}:${candidateId}:${run.id}`); const [confirmed, setConfirmed] = useState(false);
  const observeCancel = cancel.observe, observeReconcile = reconcile.observe;
  useEffect(() => { void observeCancel(run); void observeReconcile(run); }, [run, observeCancel, observeReconcile]);
  return <><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t('life.runControlConfirm')}</label>
    <button disabled={!confirmed || cancel.busy || reconcile.busy || run.status !== 'running'} onClick={() => void cancel.run(`${base}/cancel`, { runId: run.id }).then(ok => { if (ok) void onChanged(); })}>{t('life.stopRun')}</button>
    <button disabled={!confirmed || cancel.busy || reconcile.busy} onClick={() => void reconcile.run(`${base}/reconcile`, { runId: run.id, confirmed: true }).then(ok => { if (ok) void onChanged(); })}>{t('life.reconcileRun')}</button>
    <MutationStatus {...cancel} retry={() => void cancel.run().then(ok => { if (ok) void onChanged(); })} /><MutationStatus {...reconcile} retry={() => void reconcile.run().then(ok => { if (ok) void onChanged(); })} /></>;
}
