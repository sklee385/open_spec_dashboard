import { useEffect, useRef, useState } from 'react';
import { exactMutation, readExactMutation, type ExactReceipt } from '../lib/exactMutation';
import { SupersededMutationError } from '../lib/workspaceFlowApi';
import { useI18n } from '../i18n/context';
export function useExactMutation(scope: string) {
  const { t } = useI18n(); const [receipt, setReceipt] = useState<ExactReceipt | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''); const identity = useRef(scope), pending = useRef(false);
  // Restore the persisted control request for this candidate/run identity.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { identity.current = scope; pending.current = false; setBusy(false); try { setReceipt(readExactMutation(scope)); setError(''); } catch (e) { setError(String(e)); } return () => { identity.current = ''; }; }, [scope]);
  async function run(endpoint?: string, body?: Record<string, unknown>) {
    if (pending.current) return false; const current = scope; pending.current = true; setBusy(true); setError('');
    try { await exactMutation(current, endpoint, body, value => { if (identity.current === current) setReceipt(value); }, endpoint ? undefined : receipt); return identity.current === current; }
    catch (e) { if (identity.current === current) setError(e instanceof SupersededMutationError ? t('flow.superseded') : e instanceof Error ? e.message : String(e)); return false; }
    finally { if (identity.current === current) { pending.current = false; setBusy(false); try { setReceipt(readExactMutation(current)); } catch (e) { setError(String(e)); } } }
  }
  return { receipt, busy, error, run };
}
