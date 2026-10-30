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
  if (endpoint.endsWith('/browser/reconcile') && data.reconciliation === 'terminated' && data.cleanupStatus === 'confirmed' && data.processTerminated === true) return 'completed';
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

export type ExactObservation = { captureId?: string; expectedHash?: string; workId?: string; candidateId?: string | null; owner?: string; cleanupStatus?: string; reconciliation?: string; id?: string; requestKey?: string; candidateVersion?: string; expectedVersion?: string; status?: string; processTerminated?: boolean };
/** Observe only the exact persisted operation; no POST, worker termination or verification success is inferred. */
export async function observeExactMutation(scope: string, expected: ExactReceipt | null, row: ExactObservation, live?: string): Promise<ExactReceipt | null> {
  if (!expected || expected.state !== 'uncertain') return null;
  let completed = false;
  const browser = /^\/api\/work\/([^/]+)(?:\/integration\/([^/]+))?\/browser\/(run|cancel|reconcile)$/.exec(expected.endpoint);
  const cleanup = /^\/api\/work\/([^/]+)\/workspace\/cleanup(?:\?candidateId=([^&]+))?$/.exec(expected.endpoint);
  const image = /^\/api\/work\/([^/]+)\/completion\/evidence\/([^/]+)\/expire$/.exec(expected.endpoint);
  if (browser) {
    if (row.workId !== decodeURIComponent(browser[1]) || (row.candidateId ?? null) !== (browser[2] ? decodeURIComponent(browser[2]) : null) || !row.id) return null;
    if (browser[3] === 'run') {
      if (row.owner !== 'user' || typeof expected.body.requestKey !== 'string' || row.requestKey !== expected.body.requestKey || !['running', 'passed', 'failed', 'blocked', 'stale', 'interrupted'].includes(row.status ?? '')) return null;
    } else {
      if (typeof expected.body.runId !== 'string' || row.id !== expected.body.runId || row.processTerminated !== true || !['passed', 'failed', 'blocked', 'stale', 'interrupted', 'cancelled'].includes(row.status ?? '')) return null;
      if (browser[3] === 'reconcile' && (row.cleanupStatus !== 'confirmed' || row.reconciliation !== 'terminated')) return null;
    }
    completed = true; // Transport/control accepted; verification outcome remains in the server row.
  } else if (cleanup) {
    if (row.workId !== decodeURIComponent(cleanup[1]) || (row.candidateId ?? null) !== (cleanup[2] ? decodeURIComponent(cleanup[2]) : null) || typeof expected.body.requestKey !== 'string' || row.requestKey !== expected.body.requestKey || typeof expected.body.expectedVersion !== 'string' || row.expectedVersion !== expected.body.expectedVersion || row.processTerminated !== true || !['removed','failed'].includes(row.status ?? '')) return null;
    completed = row.status === 'removed';
  } else if (image) {
    if (row.workId !== decodeURIComponent(image[1]) || row.id !== decodeURIComponent(image[2]) || typeof expected.body.captureId !== 'string' || row.captureId !== expected.body.captureId || typeof expected.body.expectedHash !== 'string' || row.expectedHash !== expected.body.expectedHash || row.status !== 'expired') return null;
    completed = true; // This is a DB asset state, not a process-exit assertion.
  } else {
    if (row.processTerminated !== true) return null;
    const route = /^\/api\/work\/([^/]+)\/integration\/([^/]+)\/(apply(?:\/reconcile)?|verification\/(?:run|cancel|reconcile))$/.exec(expected.endpoint);
    if (!route || row.workId !== decodeURIComponent(route[1]) || row.candidateId !== decodeURIComponent(route[2])) return null;
    const operation = route[3];
    if (operation.startsWith('apply')) {
      if (live !== 'settled' || !['applied', 'failed'].includes(row.status ?? '') || typeof expected.body.requestKey !== 'string' || row.requestKey !== expected.body.requestKey) return null;
      if (operation === 'apply' && (typeof expected.body.expectedVersion !== 'string' || row.expectedVersion !== expected.body.expectedVersion)) return null;
    } else {
      if (!['passed', 'failed', 'blocked', 'stale', 'interrupted', 'cancelled'].includes(row.status ?? '')) return null;
      if (operation === 'verification/run') {
        if (typeof expected.body.requestKey !== 'string' || row.requestKey !== expected.body.requestKey || typeof expected.body.candidateVersion !== 'string' || row.candidateVersion !== expected.body.candidateVersion) return null;
      } else if (typeof expected.body.runId !== 'string' || row.id !== expected.body.runId) return null;
    }
    completed = ['applied', 'passed', 'cancelled'].includes(row.status ?? '');
  }
  return lock(scope, () => {
    const current = readExactMutation(scope);
    if (!current || current.localId !== expected.localId || current.attemptId !== expected.attemptId || current.endpoint !== expected.endpoint || JSON.stringify(current.body) !== JSON.stringify(expected.body)) return null;
    const next: ExactReceipt = { ...current, attemptId: crypto.randomUUID(), state: completed ? 'completed' : 'failed', response: { observed: true, receipt: row }, error: undefined };
    draftStorage.setItem(`${key(scope)}:history:${current.attemptId}`, JSON.stringify(current));
    draftStorage.setItem(key(scope), JSON.stringify(next)); return next;
  });
}
