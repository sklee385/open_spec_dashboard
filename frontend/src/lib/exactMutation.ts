import { draftStorage } from './draftStorage';
import { SupersededMutationError, WorkspaceFlowError } from './workspaceFlowApi';
export type ExactReceipt = { localId: string; attemptId: string; endpoint: string; body: Record<string, unknown>; state: 'uncertain' | 'completed' | 'failed'; response?: unknown; error?: string; createdAt: string };
const key = (scope: string) => `integration-control:${scope}`;
export function readExactMutation(scope: string): ExactReceipt | null {
  const value = JSON.parse(draftStorage.getItem(key(scope)) ?? 'null') as ExactReceipt | null;
  if (value && (!value.localId || !value.endpoint?.startsWith('/api/work/') || !value.body || !['uncertain', 'completed', 'failed'].includes(value.state))) throw new Error('Invalid saved control request');
  return value;
}
async function lock<T>(scope: string, action: () => T): Promise<T> { return navigator.locks?.request ? navigator.locks.request(key(scope), action) : action(); }
function resultState(endpoint: string, data: Record<string, unknown>): ExactReceipt['state'] {
  const nested = data.receipt && typeof data.receipt === 'object' ? data.receipt as Record<string, unknown> : null;
  const live = data.live && typeof data.live === 'object' ? data.live as Record<string, unknown> : null;
  const status = String(nested?.status ?? data.status ?? '');
  if (['running', 'uncertain', 'preparing'].includes(status) || ['active', 'unknown'].includes(String(live?.state)) || data.reconciliation === 'termination-unconfirmed') return 'uncertain';
  if (endpoint.endsWith('/apply/reconcile') && (!nested || data.reconciled === false && status !== 'applied')) return 'uncertain';
  return ['failed', 'blocked', 'stale', 'interrupted'].includes(status) ? 'failed' : 'completed';
}
export async function exactMutation<T>(scope: string, endpoint?: string, body?: Record<string, unknown>, onPersist?: (value: ExactReceipt) => void, expected?: ExactReceipt | null): Promise<T> {
  const receipt = await lock(scope, () => {
    const previous = readExactMutation(scope);
    if (expected !== undefined && JSON.stringify(previous) !== JSON.stringify(expected)) throw new SupersededMutationError();
    if (endpoint && previous?.state === 'uncertain') throw new Error('Inspect the saved control request first');
    if (!endpoint && !previous) throw new Error('No saved control request');
    if (previous) draftStorage.setItem(`${key(scope)}:history:${previous.attemptId}`, JSON.stringify(previous));
    const next: ExactReceipt = { localId: endpoint ? crypto.randomUUID() : previous!.localId, attemptId: crypto.randomUUID(), endpoint: endpoint ?? previous!.endpoint, body: endpoint ? body ?? {} : previous!.body, state: 'uncertain', createdAt: new Date().toISOString() };
    draftStorage.setItem(key(scope), JSON.stringify(next)); return next;
  });
  onPersist?.(receipt);
  const finish = () => lock(scope, () => {
    const current = readExactMutation(scope);
    if (current?.attemptId !== receipt.attemptId || current.endpoint !== receipt.endpoint || JSON.stringify(current.body) !== JSON.stringify(receipt.body)) throw new SupersededMutationError();
    draftStorage.setItem(key(scope), JSON.stringify(receipt));
  });
  try {
    const response = await fetch(receipt.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(receipt.body) }); const data = await response.json();
    if (!response.ok) throw new WorkspaceFlowError(response.status, data);
    receipt.response = data; receipt.state = resultState(receipt.endpoint, data); await finish(); return data as T;
  } catch (error) {
    if (error instanceof SupersededMutationError) throw error;
    receipt.error = error instanceof Error ? error.message : String(error);
    if (error instanceof WorkspaceFlowError && typeof receipt.body.requestKey === 'string' && error.data.requestKey === receipt.body.requestKey && error.data.mutationOutcome === 'rejected-before-intent') { receipt.state = 'failed'; receipt.response = error.data; }
    await finish(); throw error;
  }
}
