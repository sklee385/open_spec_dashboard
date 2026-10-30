import { useCallback, useEffect, useRef, useState } from 'react';
import { exactMutation, observeExactMutation, readExactMutation, type ExactObservation, type ExactReceipt } from '../lib/exactMutation';
import { SupersededMutationError } from '../lib/workspaceFlowApi';
import { useI18n } from '../i18n/context';
export function useExactMutation(scope: string) {
  const { t } = useI18n(); const [receipt, setReceipt] = useState<ExactReceipt | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const identity = useRef(scope), pending = useRef(false), operation = useRef(0), saved = useRef<ExactReceipt | null>(null);
  const persist = (value: ExactReceipt | null) => { saved.current = value; setReceipt(value); };
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { identity.current = scope; operation.current++; pending.current = false; setBusy(false); try { persist(readExactMutation(scope)); setError(''); } catch (e) { setError(String(e)); } return () => { identity.current = ''; }; }, [scope]);
  const observe = useCallback(async (row: ExactObservation, live?: string) => {
    const generation = operation.current;
    try {
      const next = await observeExactMutation(scope, saved.current, row, live);
      if (!next || identity.current !== scope || operation.current !== generation || readExactMutation(scope)?.attemptId !== next.attemptId) return false;
      operation.current++; pending.current = false; setBusy(false); setError(''); saved.current = next; setReceipt(next); return true;
    } catch (e) { if (identity.current === scope && operation.current === generation) setError(String(e)); return false; }
  }, [scope]);
  async function run(endpoint?: string, body?: Record<string, unknown>) {
    if (pending.current) return false; const current = scope, generation = ++operation.current; pending.current = true; setBusy(true); setError('');
    const owned = () => identity.current === current && operation.current === generation;
    try { await exactMutation(current, endpoint, body, value => { if (owned()) persist(value); }, endpoint ? undefined : saved.current); return owned(); }
    catch (e) { if (owned()) setError(e instanceof SupersededMutationError ? t('flow.superseded') : e instanceof Error ? e.message : String(e)); return false; }
    finally { if (owned()) { pending.current = false; setBusy(false); try { persist(readExactMutation(current)); } catch (e) { setError(String(e)); } } }
  }
  return { receipt, busy, error, run, observe };
}