import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/context';
import { blocksNewMutation, flowGet } from '../lib/workspaceFlowApi';
import { useDurableMutation } from '../hooks/useDurableMutation';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { draftStorage } from '../lib/draftStorage';
import type { WorkspacePreview } from '../types/workspaceFlow';
import { MutationStatus } from './WorkspaceFlowShared';
import './WorkspaceFlow.css';
type Command = { id: string; stage: 'install' | 'build'; command: string; argsText: string };
type Draft = { branch: string; runtime: string; dependencies: string; paths: string; generated: string; commands: Command[] };
type SavedPolicy = { runtime: string; dependencies: string; paths: string[]; generatedPaths: string[]; commands: { id: string; stage: string; command: string; args: string[] }[] };
function savedPreparationPolicy(value: unknown): SavedPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const policy = value as SavedPolicy;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every(item => typeof item === 'string');
  if (!['node', 'none'].includes(policy.runtime) || !['none', 'copy', 'install'].includes(policy.dependencies) || !strings(policy.paths) || !strings(policy.generatedPaths) || !Array.isArray(policy.commands) || !policy.commands.every(command => command && typeof command.id === 'string' && typeof command.command === 'string' && ['install', 'build'].includes(command.stage) && strings(command.args))) return null;
  return policy;
}
const empty: Draft = { branch: '', runtime: 'none', dependencies: 'none', paths: '', generated: '', commands: [] };
const lines = (value: string) => value.split(/\r?\n/).filter(value => value.trim());
export function WorkspacePreparation({ workId, reviewedVersion, onStatus }: { workId: string; reviewedVersion?: string | null; onStatus?: (value: WorkspacePreview) => void }) {
  const { t } = useI18n(); const draftKey = `workspace-preparation-draft:${workId}`;
  const [draft, setDraft] = useState<Draft>(() => { try { return { ...empty, ...JSON.parse(draftStorage.getItem(draftKey) ?? '{}') }; } catch { return empty; } });
  const [preview, setPreview] = useState<WorkspacePreview | null>(null), [confirmed, setConfirmed] = useState(false), [recoverConfirmed, setRecoverConfirmed] = useState(false), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const mutation = useDurableMutation(`workspace:${workId}`); const sequence = useRef(0), statusCallback = useRef(onStatus);
  useLayoutEffect(() => { statusCallback.current = onStatus; }, [onStatus]);
  const persistence = useLocalDraft(draftKey, draft, true, () => setError(t('flow.storage')));
  const base = `/api/work/${encodeURIComponent(workId)}/workspace`;
  const load = useCallback(async (branch = '') => {
    const token = ++sequence.current; setLoading(true); setError(''); setConfirmed(false); setRecoverConfirmed(false);
    try { const status = await flowGet<WorkspacePreview>(base); if (token !== sequence.current) return; statusCallback.current?.(status);
      const next = status.experimentalEnabled && status.status !== 'ready' ? await flowGet<WorkspacePreview>(`${base}/preview${branch ? `?${new URLSearchParams({ selectedBranch: branch })}` : ''}`) : status;
      if (token === sequence.current) { setPreview(next); statusCallback.current?.(next); }
    } catch (e) { if (token === sequence.current) setError(String(e)); } finally { if (token === sequence.current) setLoading(false); }
  }, [base]);
  // Initialize the external preview for this work/candidate identity.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(draft.branch); return () => { sequence.current++; }; }, [load, reviewedVersion]); // refresh only the read snapshot after document review
  if (!preview?.experimentalEnabled) return error ? <p role="alert">{error}</p> : loading ? <p role="status">{t('flow.loading')}</p> : null;
  const update = (value: Partial<Draft>) => { setDraft(old => ({ ...old, ...value })); setConfirmed(false); };
  const locked = loading || mutation.busy || blocksNewMutation(mutation.receipt);
  const savedBody = mutation.receipt?.body;
  const savedPolicy = savedPreparationPolicy(savedBody?.policy);
  const prepare = async () => {
    if (!preview || !confirmed || !persistence.flush()) return;
    const documents = preview.documents;
    const body = { confirmed: true, selectedBranch: preview.git?.selectedBranch, ...(documents ? { excludedConfirmed: true, previewToken: documents.confirmationToken, policy: { version: 1, confirmed: true, projectId: preview.projectId, planRevision: documents.planRevision, runtime: draft.runtime, dependencies: draft.dependencies, paths: lines(draft.paths), generatedPaths: lines(draft.generated), commands: draft.commands.map(({ argsText, ...command }) => ({ ...command, args: argsText === '' ? [] : argsText.split(/\r?\n/) })) } } : {}) };
    if (await mutation.run(`${base}/prepare`, body)) await load(draft.branch);
  };
  return <section className="workspace-flow" aria-label={t('flow.prepare')}><header><h3>{t('flow.prepare')}</h3><button disabled={loading || mutation.busy} onClick={() => void load(draft.branch)}>{t('flow.refresh')}</button></header>
    {loading && <p role="status">{t('flow.loading')}</p>}
    {preview.status === 'ready' ? <p role="status">{t('flow.ready')}</p> : <>
      {preview.git?.reason && <p role="alert">{preview.git.reason}</p>}
      <label>{t('flow.branch')}<select aria-label={t('flow.branch')} value={draft.branch || preview.git?.selectedBranch || ''} disabled={locked} onChange={event => { update({ branch: event.target.value }); void load(event.target.value); }}><option value="">—</option>{preview.git?.branches.map(branch => <option key={branch.name} value={branch.name}>{branch.name}</option>)}</select></label>
      <dl><dt>HEAD</dt><dd>{preview.git?.head ?? '—'}</dd><dt>{t('flow.base')}</dt><dd>{preview.git?.baseCommit ?? '—'}</dd></dl>
      {preview.documents && <><details open><summary>{t('flow.documents')}</summary><ul>{preview.documents.manifest.files.map(file => <li key={file.path}>{file.path}</li>)}</ul></details><details open><summary>{t('flow.excluded')}</summary><ul>{preview.documents.excluded.map(entry => <li key={entry.path}><code>{entry.index}{entry.worktree}</code> {entry.path}</li>)}</ul><p>{preview.documents.guidance}</p></details>
        <fieldset disabled={locked}><legend>{t('flow.policy')}</legend><div className="workspace-flow-fields"><label>{t('flow.runtime')}<select value={draft.runtime} onChange={e => update({ runtime: e.target.value })}><option value="none">{t('flow.none')}</option><option value="node">Node</option></select></label><label>{t('flow.dependencies')}<select value={draft.dependencies} onChange={e => update({ dependencies: e.target.value })}><option value="none">{t('flow.none')}</option><option value="copy">{t('flow.copy')}</option><option value="install">{t('flow.install')}</option></select></label></div>
          <label>{t('flow.paths')}<textarea value={draft.paths} onChange={e => update({ paths: e.target.value })} /></label><label>{t('flow.generated')}<textarea value={draft.generated} onChange={e => update({ generated: e.target.value })} /></label>
          {draft.commands.map((command, index) => <fieldset key={index}><legend>{index + 1}</legend>{(['id', 'command', 'argsText'] as const).map(field => <label key={field}>{t(field === 'id' ? 'flow.commandId' : field === 'command' ? 'flow.executable' : 'flow.arguments')}{field === 'argsText' ? <textarea value={command[field]} onChange={e => update({ commands: draft.commands.map((row, i) => i === index ? { ...row, [field]: e.target.value } : row) })} /> : <input value={command[field]} onChange={e => update({ commands: draft.commands.map((row, i) => i === index ? { ...row, [field]: e.target.value } : row) })} />}</label>)}<label>{t('flow.stage')}<select value={command.stage} onChange={e => update({ commands: draft.commands.map((row, i) => i === index ? { ...row, stage: e.target.value as Command['stage'] } : row) })}><option value="install">{t('flow.install')}</option><option value="build">{t('flow.build')}</option></select></label><button onClick={() => update({ commands: draft.commands.filter((_, i) => i !== index) })}>{t('flow.remove')}</button></fieldset>)}
          <button disabled={draft.commands.length >= 20} onClick={() => update({ commands: [...draft.commands, { id: '', stage: 'build', command: '', argsText: '' }] })}>{t('flow.commandAdd')}</button></fieldset></>}
      <label><input type="checkbox" checked={confirmed} disabled={loading || mutation.busy} onChange={event => setConfirmed(event.target.checked)} />{t('flow.confirm')}</label><button disabled={locked || !confirmed || !(preview.git?.state === 'ready' && preview.documents || preview.git?.copyEligible)} onClick={() => void prepare()}>{t('flow.prepare')}</button>
      {mutation.receipt && mutation.receipt.state !== 'completed' && preview.documents && savedPolicy && <><p>{t('flow.recoverHint')}</p>
        <section aria-label={t('flow.savedPolicy')}><h4>{t('flow.savedPolicy')}</h4><dl><dt>{t('flow.branch')}</dt><dd>{String(savedBody?.selectedBranch ?? '—')}</dd><dt>{t('flow.runtime')}</dt><dd>{savedPolicy.runtime === 'node' ? 'Node' : t('flow.none')}</dd><dt>{t('flow.dependencies')}</dt><dd>{t(savedPolicy.dependencies === 'install' ? 'flow.install' : savedPolicy.dependencies === 'copy' ? 'flow.copy' : 'flow.none')}</dd></dl>
          <p>{t('flow.paths')}</p><ul>{savedPolicy.paths?.map(path => <li key={path}>{path}</li>)}</ul><p>{t('flow.generated')}</p><ul>{savedPolicy.generatedPaths?.map(path => <li key={path}>{path}</li>)}</ul>
          {savedPolicy.commands?.map(command => <div key={command.id}><dl><dt>{t('flow.commandId')}</dt><dd>{command.id}</dd><dt>{t('flow.stage')}</dt><dd>{t(command.stage === 'install' ? 'flow.install' : 'flow.build')}</dd><dt>{t('flow.executable')}</dt><dd><code>{command.command}</code></dd></dl><p>{t('flow.arguments')}</p><ol>{command.args.map((arg, index) => <li key={index}><code>{arg}</code></li>)}</ol></div>)}
        </section>
        <label><input type="checkbox" checked={recoverConfirmed} disabled={loading || mutation.busy} onChange={event => setRecoverConfirmed(event.target.checked)} />{t('flow.recoverConfirm')}</label>
        <button disabled={loading || mutation.busy || !recoverConfirmed} onClick={() => { if (persistence.flush()) { setRecoverConfirmed(false); void mutation.recover(preview.documents!.confirmationToken).then(ok => { if (ok) void load(draft.branch); }); } }}>{t('flow.recover')}</button></>}
    </>}
    {preview.executionPath && <p>{t('flow.path')}: <code>{preview.executionPath}</code></p>}{preview.preparation?.map((row, index) => <p key={index}>{row.stage}: {row.status} {row.error}</p>)}{error && <p role="alert">{error}</p>}
    <MutationStatus {...mutation} retry={() => void mutation.run().then(ok => { if (ok) void load(draft.branch); })} />
  </section>;
}
