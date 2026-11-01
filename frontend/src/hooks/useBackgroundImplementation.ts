import { useCallback, useSyncExternalStore } from 'react';

// Scoped by work, rather than by a mounted room. Never abort server execution
// when a viewer leaves; the server remains the authority for actual run state.
const pending = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
export const implementationPending = (id?: string) => !!id && pending.has(id);
export function useBackgroundImplementation(id?: string) {
  const subscribe = useCallback((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  const snapshot = useCallback(() => implementationPending(id), [id]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
export async function startBackgroundImplementation(id: string, run: () => Promise<unknown>) {
  if (pending.has(id)) return false;
  pending.add(id); notify();
  try { await run(); return true; }
  finally { pending.delete(id); notify(); }
}
