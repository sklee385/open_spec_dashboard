import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context';
import { blocksNewMutation, flowGet } from '../lib/workspaceFlowApi';
import { useDurableMutation } from '../hooks/useDurableMutation';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { draftStorage } from '../lib/draftStorage';
import type { CandidateEditPreview } from '../types/workspaceFlow';
import { FileSelection, MutationStatus } from './WorkspaceFlowShared';
export function CandidateEditing({ workId, candidateId, dirty, onChanged }: { workId: string; candidateId: string; dirty: boolean; onChanged: () => void }) {
  const { t } = useI18n(); const base = `/api/work/${encodeURIComponent(workId)}/integration/${encodeURIComponent(candidateId)}/edit`, scope = `candidate-edit:${workId}:${candidateId}`;
  const [view, setView] = useState<CandidateEditPreview | null>(null), [error, setError] = useState(''), [confirmed, setConfirmed] = useState(false), [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<{ paths: string[]; message: string }>(() => { try { return { paths: [], message: '', ...JSON.parse(draftStorage.getItem(scope) ?? '{}') }; } catch { return { paths: [], message: '' }; } });
  const mutation = useDurableMutation(scope), reconcile = useDurableMutation(`${scope}:reconcile`), sequence = useRef(0);
  const persistence = useLocalDraft(scope, draft, true, () => setError(t('flow.storage')));
  const load = useCallback(async () => { const token = ++sequence.current; setLoading(true); setConfirmed(false); try { const next = await flowGet<CandidateEditPreview>(`${base}/preview`); if (token === sequence.current) { if (!next.candidateVersion || !Array.isArray(next.entries) || !Array.isArray(next.conflicts)) throw new Error('Candidate preview unavailable'); setView(next); setError(''); } } catch (e) { if (token === sequence.current) { setView(null); setError(String(e)); } } finally { if (token === sequence.current) setLoading(false); } }, [base]);
  // Initialize the external preview for this work/candidate identity.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [load]);
  const locked = loading || dirty || mutation.busy || reconcile.busy || blocksNewMutation(mutation.receipt);
  const send = async (kind: 'stage' | 'commit') => { if (!view || !confirmed || !persistence.flush()) return; if (await mutation.run(`${base}/${kind}`, { confirmed: true, candidateVersion: view.candidateVersion, paths: draft.paths, ...(kind === 'commit' ? { message: draft.message } : {}) })) { await load(); onChanged(); } };
  return <section className="workspace-flow" aria-label={t('flow.edit')}><header><h3>{t('flow.edit')}</h3><button disabled={mutation.busy || reconcile.busy} onClick={() => void load()}>{t('flow.refresh')}</button></header><p>{t('flow.candidateHint')}</p>
    {loading && <p role="status">{t('flow.loading')}</p>}
    {error && <p role="alert">{error}</p>}{view && <><p>{view.mode} · {view.head}</p><p>{t('flow.currentConflicts')}: {view.entries.filter(row => row.index === 'U' || row.worktree === 'U' || ['AA', 'DD'].includes(`${row.index}${row.worktree}`)).length}</p><FileSelection entries={view.entries} paths={draft.paths} setPaths={paths => { setDraft(old => ({ ...old, paths })); setConfirmed(false); }} disabled={locked} />
      {!!view.conflicts.length && <details><summary>{t('flow.historyConflicts')}</summary>{view.conflicts.map(path => <p key={path}>{path}</p>)}</details>}{view.mode === 'conflict' && <p>{t('flow.emptyResolution')}</p>}<label>{t('flow.message')}<textarea value={draft.message} onChange={e => { setDraft(old => ({ ...old, message: e.target.value })); setConfirmed(false); }} /></label><label><input type="checkbox" disabled={locked} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('flow.confirm')}</label><button disabled={locked || !confirmed || !draft.paths.length} onClick={() => void send('stage')}>{t('flow.stageFiles')}</button><button disabled={locked || !confirmed || !draft.message.trim() || view.mode === 'revision' && !draft.paths.length} onClick={() => void send('commit')}>{t('flow.commitCandidate')}</button></>}
    <MutationStatus {...mutation} retry={() => void mutation.run().then(ok => { if (ok) { void load(); onChanged(); } })} />
    {mutation.receipt?.state === 'uncertain' && <button disabled={mutation.busy || reconcile.busy} onClick={() => void reconcile.run(`${base}/reconcile`, { requestKey: mutation.receipt!.body.requestKey, confirmed: true }).then(ok => { if (ok) { void load(); onChanged(); } })}>{t('flow.reconcile')}</button>}
    <MutationStatus {...reconcile} retry={() => void reconcile.run().then(ok => { if (ok) void load(); })} />
  </section>;
}
