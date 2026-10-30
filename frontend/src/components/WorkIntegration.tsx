import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context';
import { blocksNewMutation, flowGet } from '../lib/workspaceFlowApi';
import { useDurableMutation } from '../hooks/useDurableMutation';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { draftStorage } from '../lib/draftStorage';
import type { CandidatePreview, CommitPreview, IntegrationRequest, ReservationPreview } from '../types/workspaceFlow';
import { FileSelection, MutationStatus } from './WorkspaceFlowShared';
import './WorkspaceFlow.css';
import { CandidateLifecycle } from './CandidateLifecycle';
export function WorkIntegration({ workId, active: visible = true, workDirty = false, sourceId, onAppliedChange, onOpenCandidate }: { workId: string; active?: boolean; workDirty?: boolean; sourceId?: string; onAppliedChange?: (applied: boolean) => void; onOpenCandidate?: (candidateId: string, executionPath: string) => void }) {
  const { t } = useI18n(); const base = `/api/work/${encodeURIComponent(workId)}/integration`, draftKey = `integration-draft:${workId}`;
  const [draft, setDraft] = useState<{ target: string; paths: string[]; message: string }>(() => { try { return { target: '', paths: [], message: '', ...JSON.parse(draftStorage.getItem(draftKey) ?? '{}') }; } catch { return { target: '', paths: [], message: '' }; } });
  const [active, setActive] = useState<IntegrationRequest | null>(null), [history, setHistory] = useState<IntegrationRequest[]>([]), [reservation, setReservation] = useState<ReservationPreview | null>(null), [commit, setCommit] = useState<CommitPreview | null>(null), [candidate, setCandidate] = useState<CandidatePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false), [error, setError] = useState(''), [loading, setLoading] = useState(false); const sequence = useRef(0), lastStatus = useRef('');
  const [inspected, setInspected] = useState<string | null>(null);
  useEffect(() => { onAppliedChange?.(!active && !error && history.at(-1)?.status === 'applied'); }, [active, error, history, onAppliedChange]);
  const mutation = useDurableMutation(`integration:${workId}`);
  const persistence = useLocalDraft(draftKey, draft, true, () => setError(t('flow.storage')));
  const load = useCallback(async () => {
    const token = ++sequence.current; setLoading(true); setError(''); setConfirmed(false);
    try { const next = await flowGet<{ requests: IntegrationRequest[]; active: IntegrationRequest | null }>(base); if (token !== sequence.current) return; lastStatus.current = JSON.stringify(next); setActive(next.active); setHistory(next.requests); setCommit(null); setCandidate(null); setReservation(null);
      if (!next.active) { const view = await flowGet<ReservationPreview>(`${base}/reservation-preview`); if (token === sequence.current) setReservation(view); }
      else if (['queued'].includes(next.active.status) && !next.active.resultCommit) { const view = await flowGet<CommitPreview>(`${base}/commit-preview`); if (token === sequence.current) setCommit(view); }
      else if (next.active.resultCommit && ['queued'].includes(next.active.status)) { const view = await flowGet<CandidatePreview>(`${base}/${encodeURIComponent(next.active.candidateId)}/preview`); if (token === sequence.current) setCandidate(view); }
    } catch (e) { if (token === sequence.current) setError(String(e)); } finally { if (token === sequence.current) setLoading(false); }
  }, [base]);
  // Initialize the external preview for this work/candidate identity.
  useEffect(() => {
    if (!visible) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(); let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState !== 'hidden') {
        try { const next = await flowGet<{ requests: IntegrationRequest[]; active: IntegrationRequest | null }>(base); if (!stopped && JSON.stringify(next) !== lastStatus.current) await load(); }
        catch (e) { if (!stopped) setError(String(e)); }
      }
      if (!stopped) timer = setTimeout(poll, 10000);
    };
    // Invalidate the request generation, rather than dereferencing a DOM node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    timer = setTimeout(poll, 10000); return () => { stopped = true; sequence.current++; clearTimeout(timer); };
  }, [base, load, visible]);
  const update = (value: Partial<typeof draft>) => { setDraft(old => ({ ...old, ...value })); setConfirmed(false); };
  const locked = loading || mutation.busy || blocksNewMutation(mutation.receipt);
  const send = async (endpoint: string, body: Record<string, unknown>) => { if (!confirmed || !persistence.flush()) return; if (await mutation.run(endpoint, body)) await load(); };
  const branch = reservation?.branches.find(row => row.name === draft.target);
  const selected = history.find(row => row.candidateId === inspected) ?? active ?? history.at(-1) ?? null;
  return <section className="workspace-flow" aria-label={t('flow.integration')}><header><h3>{t('flow.integration')}</h3><button disabled={loading || mutation.busy} onClick={() => void load()}>{t('flow.refresh')}</button></header>
    {loading && <p role="status">{t('flow.loading')}</p>}
    {active ? <><dl><dt>{t('flow.status')}</dt><dd>{active.status}</dd><dt>{t('flow.target')}</dt><dd>{active.targetBranch}</dd><dt>{t('flow.base')}</dt><dd>{active.targetHead}</dd><dt>{t('flow.workHead')}</dt><dd>{active.workHead}</dd><dt>{t('flow.path')}</dt><dd>{active.executionPath}</dd>{active.resultCommit && <><dt>{t('flow.commit')}</dt><dd>{active.resultCommit}</dd></>}{active.candidateCommit && <><dt>{t('flow.integration')}</dt><dd>{active.candidateCommit}</dd></>}</dl>{active.error && <p role="alert">{active.error}</p>}
      {commit && <><FileSelection entries={commit.entries} paths={draft.paths} setPaths={paths => update({ paths })} disabled={locked} /><label>{t('flow.message')}<textarea value={draft.message} onChange={e => update({ message: e.target.value })} /></label><button disabled={locked || !confirmed || !draft.message.trim()} onClick={() => void send(`${base}/result-commit`, { confirmed: true, integrationId: commit.integrationId, previewVersion: commit.version, paths: draft.paths, message: draft.message })}>{t('flow.commit')}</button></>}
      {candidate && <><p>{candidate.branch} · {candidate.resultCommit}</p><button disabled={locked || !confirmed} onClick={() => void send(`${base}/${encodeURIComponent(active.candidateId)}/prepare`, { confirmed: true, expectedVersion: candidate.candidateVersion })}>{t('flow.prepareCandidate')}</button></>}
      {active.status === 'validating' && <p role="status">{t('flow.validating')}</p>}{active.status === 'conflicted' && <p role="alert">{t('flow.conflicted')}</p>}
      {['conflicted', 'validating', 'ready'].includes(active.status) && onOpenCandidate && <button onClick={() => onOpenCandidate(active.candidateId, active.executionPath)}>{t('flow.openCandidate')}</button>}
    </> : reservation && <><dl><dt>{t('flow.workHead')}</dt><dd>{reservation.workHead}</dd><dt>{t('flow.sourceHead')}</dt><dd>{reservation.sourceBranch ?? '—'} · {reservation.sourceHead}</dd></dl><label>{t('flow.target')}<select aria-label={t('flow.target')} value={draft.target} disabled={locked} onChange={e => update({ target: e.target.value })}><option value="">—</option>{reservation.branches.map(row => <option key={row.name} value={row.name}>{row.name}</option>)}</select></label>{branch && <p>{t('flow.base')}: {branch.commit}</p>}<button disabled={locked || !confirmed || !branch} onClick={() => branch && void send(base, { confirmed: true, targetBranch: branch.name, expectedTargetHead: branch.commit, expectedWorkHead: reservation.workHead, reviewedVersion: reservation.reviewedVersion })}>{t('flow.reserve')}</button></>}
    {(reservation || commit || candidate) && <label><input type="checkbox" checked={confirmed} disabled={locked} onChange={e => setConfirmed(e.target.checked)} />{t('flow.confirm')}</label>}
    <MutationStatus {...mutation} retry={() => void mutation.run().then(ok => { if (ok) void load(); })} />{error && <p role="alert">{error}</p>}
    {selected && <CandidateLifecycle workId={workId} candidate={selected} sourceId={sourceId} workDirty={workDirty} active={visible} onChanged={() => void load()} />}
    {!!history.length && <details><summary>{t('flow.status')} ({history.length})</summary>{history.map(row => <div key={row.id}><p>{row.candidateId}: {row.status} · {row.targetBranch}</p><button onClick={() => setInspected(row.candidateId)}>{t('life.historyInspect')} {row.candidateId}</button></div>)}</details>}
  </section>;
}
