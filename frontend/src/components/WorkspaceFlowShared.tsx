import { useI18n } from '../i18n/context';
import type { MutationReceipt } from '../lib/workspaceFlowApi';
import type { FlowEntry } from '../types/workspaceFlow';
export function MutationStatus({ receipt, busy, error, retry }: { receipt: MutationReceipt | null; busy: boolean; error: string; retry: () => void }) {
  const { t } = useI18n();
  return <>{error && <p role="alert">{error}</p>}{receipt && <div role="status"><p>{t(busy && receipt.state === 'uncertain' ? 'flow.pending' : receipt.state === 'uncertain' ? 'flow.uncertain' : receipt.state === 'completed' ? 'flow.completed' : 'flow.failed')}</p><code>{String(receipt.body.requestKey)}</code>{receipt.error && <p>{receipt.error}</p>}{receipt.state !== 'completed' && <button disabled={busy} onClick={retry}>{t('flow.retry')}</button>}</div>}</>;
}
export function FileSelection({ entries, paths, setPaths, disabled }: { entries: FlowEntry[]; paths: string[]; setPaths: (value: string[]) => void; disabled: boolean }) {
  return <ul className="workspace-flow-files">{entries.map(entry => <li key={entry.path}><label><input type="checkbox" disabled={disabled || entry.selectable === false} checked={paths.includes(entry.path)} onChange={event => setPaths(event.target.checked ? [...paths, entry.path] : paths.filter(path => path !== entry.path))} /><code>{entry.index}{entry.worktree}</code> {entry.path}</label>{entry.reason && <small>{entry.reason}</small>}</li>)}</ul>;
}
