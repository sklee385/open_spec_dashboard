import { useEffect, useRef, useState } from 'react';
import { durableMutation, readMutation, recoverWorkspace, SupersededMutationError, type MutationReceipt } from '../lib/workspaceFlowApi';
import { useI18n } from '../i18n/context';
export function useDurableMutation(scope: string) {
  const { t } = useI18n();
  const [receipt, setReceipt] = useState<MutationReceipt | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const identity = useRef(scope), pending = useRef(false);
  // Restore the persisted external receipt whenever its identity changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { identity.current = scope; pending.current = false; setBusy(false); try { setReceipt(readMutation(scope)); setError(''); } catch (e) { setError(String(e)); } return () => { identity.current = ''; }; }, [scope]);
  async function execute(operation: () => Promise<unknown>) {
    if (pending.current) return false;
    const current = scope; pending.current = true; setBusy(true); setError('');
    try { await operation(); return identity.current === current; }
    catch (e) { if (identity.current === current) setError(e instanceof SupersededMutationError ? t('flow.superseded') : e instanceof Error ? e.message : String(e)); return false; }
    finally { if (identity.current === current) { pending.current = false; setBusy(false); try { setReceipt(readMutation(current)); } catch (e) { setError(String(e)); } } }
  }
  const onPersist = (value: MutationReceipt) => { if (identity.current === scope) setReceipt(value); };
  const run = (endpoint?: string, body?: Record<string, unknown>) => execute(() => durableMutation(scope, endpoint, body, endpoint === undefined ? receipt : undefined, onPersist));
  const recover = (previewToken: string) => execute(() => recoverWorkspace(scope, previewToken, receipt, onPersist));
  return { receipt, busy, error, run, recover };
}
