import { draftStorage } from './draftStorage';
export type MutationReceipt = { endpoint: string; body: Record<string, unknown>; attemptId?: string; state: 'uncertain' | 'completed' | 'failed'; response?: unknown; error?: string; createdAt: string };
export const blocksNewMutation = (receipt: MutationReceipt | null) => !!receipt && receipt.state !== 'completed' && !(receipt.state === 'failed' && receipt.response && typeof receipt.response === 'object' && 'mutationOutcome' in receipt.response && receipt.response.mutationOutcome === 'rejected-before-intent');
const key = (scope: string) => `workspace-mutation:${scope}`;
export function readMutation(scope: string): MutationReceipt | null {
  const raw = draftStorage.getItem(key(scope));
  if (!raw) return null;
  const value = JSON.parse(raw) as MutationReceipt;
  if (!value.endpoint?.startsWith('/api/work/') && !value.endpoint?.startsWith('/api/')) throw new Error('Invalid saved endpoint');
  if (!value.body || typeof value.body.requestKey !== 'string' || !['uncertain', 'completed', 'failed'].includes(value.state)) throw new Error('Invalid saved request');
  return value;
}
export class WorkspaceFlowError extends Error {
  status: number; data: Record<string, unknown>;
  constructor(status: number, data: Record<string, unknown>) { super(String(data.message ?? data.error ?? status)); this.status = status; this.data = data; }
}
export class SupersededMutationError extends Error {
  constructor() { super('A newer saved request exists; refresh the latest state'); this.name = 'SupersededMutationError'; }
}
/** Keep locks around synchronous storage operations only, never around a fetch.
 * Web Locks coordinate same-origin tabs. The profile IPC has no cross-origin CAS;
 * without Web Locks, synchronous comparison protects the single-JS/remount case. */
async function receiptLock<T>(scope: string, action: () => T): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request(key(scope), { mode: 'exclusive' }, action);
  return action();
}
function saveAttempt(scope: string, previous: MutationReceipt | null, next: MutationReceipt) {
  if (previous) draftStorage.setItem(`${key(scope)}:history:${previous.attemptId ?? crypto.randomUUID()}`, JSON.stringify(previous));
  const attempt = { ...next, attemptId: crypto.randomUUID(), state: 'uncertain' as const, response: undefined, error: undefined };
  draftStorage.setItem(key(scope), JSON.stringify(attempt));
  return attempt;
}
function sameAttempt(current: MutationReceipt | null, expected: MutationReceipt | null) {
  return !!current && !!expected && current.attemptId === expected.attemptId && current.endpoint === expected.endpoint && JSON.stringify(current.body) === JSON.stringify(expected.body);
}
async function finishAttempt(scope: string, receipt: MutationReceipt) {
  await receiptLock(scope, () => {
    const current = readMutation(scope);
    if (!receipt.attemptId || !sameAttempt(current, receipt)) throw new SupersededMutationError();
    draftStorage.setItem(key(scope), JSON.stringify(receipt));
  });
}
export async function flowGet<T>(endpoint: string, signal?: AbortSignal): Promise<T> {
  const response = await (signal ? fetch(endpoint, { signal }) : fetch(endpoint)); const data = await response.json();
  if (!response.ok) throw new WorkspaceFlowError(response.status, data);
  return data as T;
}
/** Write before sending. An unresolved receipt can only replay its immutable request. */
export async function durableMutation<T>(scope: string, endpoint?: string, body?: Record<string, unknown>, expected?: MutationReceipt | null, onPersist?: (receipt: MutationReceipt) => void): Promise<T> {
  const receipt = await receiptLock(scope, () => {
    const previous = readMutation(scope);
    if (expected !== undefined && !sameAttempt(previous, expected)) throw new SupersededMutationError();
    if (previous?.state === 'uncertain' && endpoint !== undefined) throw new Error('Resolve the saved request before starting another request');
    if (!endpoint && !previous) throw new Error('No saved request');
    const next: MutationReceipt = endpoint ? { endpoint, body: { ...body, requestKey: typeof body?.requestKey === 'string' ? body.requestKey : crypto.randomUUID() }, state: 'uncertain', createdAt: new Date().toISOString() } : { ...previous!, state: 'uncertain' };
    return saveAttempt(scope, previous, next);
  });
  onPersist?.(receipt);
  return sendReceipt<T>(scope, receipt);
}
/** Server-sanctioned token renewal: the saved key, branch and policy stay fixed. */
export async function recoverWorkspace<T>(scope: string, previewToken: string, expected?: MutationReceipt | null, onPersist?: (receipt: MutationReceipt) => void): Promise<T> {
  const receipt = await receiptLock(scope, () => {
    const previous = readMutation(scope);
    if (expected !== undefined && !sameAttempt(previous, expected)) throw new SupersededMutationError();
    if (!previous || !/\/workspace\/(prepare|recover)$/.test(previous.endpoint) || !previewToken) throw new Error('No saved workspace preparation');
    return saveAttempt(scope, previous, { ...previous, endpoint: previous.endpoint.replace(/\/(prepare|recover)$/, '/recover'), body: { ...previous.body, previewToken }, state: 'uncertain' });
  });
  onPersist?.(receipt);
  return sendReceipt<T>(scope, receipt);
}
async function sendReceipt<T>(scope: string, receipt: MutationReceipt): Promise<T> {
  try {
    const response = await fetch(receipt.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(receipt.body) });
    const data = await response.json();
    if (!response.ok) throw new WorkspaceFlowError(response.status, data);
    receipt.state = ['uncertain', 'running', 'preparing'].includes(data.status) ? 'uncertain' : ['failed', 'recovery-required'].includes(data.status) ? 'failed' : 'completed';
    receipt.response = data; await finishAttempt(scope, receipt); return data as T;
  } catch (error) {
    if (error instanceof SupersededMutationError) throw error;
    receipt.error = error instanceof Error ? error.message : String(error);
    // Ordinary HTTP errors may follow durable intent; only a matching explicit
    // pre-intent rejection proves that a new reviewed request is safe.
    if (error instanceof WorkspaceFlowError && error.data.mutationOutcome === 'rejected-before-intent' && error.data.requestKey === receipt.body.requestKey) { receipt.state = 'failed'; receipt.response = error.data; }
    await finishAttempt(scope, receipt); throw error;
  }
}
