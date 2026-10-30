import type { WorkStore } from './store';

export const applyProtocol = 'head-pin-job-v1';
export type LiveApply = { database: string; workId: string; candidateId: string; id: string; owner: string; runGeneration?: string };
const live = new Set<LiveApply>();
const database = (store: WorkStore) => {
  const file = (store.db.prepare('PRAGMA database_list').all() as { file: string }[]).find(row => row.file)?.file ?? '';
  return process.platform === 'win32' ? file.toLowerCase() : file;
};
export function registerApply(store: WorkStore, workId: string, candidateId: string, id: string, owner: string) {
  const entry: LiveApply = { database: database(store), workId, candidateId, id, owner }; live.add(entry);
  return { entry, release: () => live.delete(entry) };
}
export function liveApply(store: WorkStore, workId: string, candidateId?: string) {
  const file = database(store);
  return [...live].find(entry => entry.database === file && entry.workId === workId && (candidateId === undefined || entry.candidateId === candidateId));
}
/** A stored PID or an old boolean never grants a recovery capability. */
export function terminatedApply(row: any, intent: any) {
  const proof = row?.terminationProof;
  if (!row || !intent || row.processTerminated !== true || intent.processTerminated !== true || row.executionProtocol !== applyProtocol || intent.executionProtocol !== applyProtocol || !proof || JSON.stringify(proof) !== JSON.stringify(intent.terminationProof)) return false;
  if (typeof row.owner !== 'string' || !row.owner || typeof row.runGeneration !== 'string' || !row.runGeneration || row.owner !== intent.owner || row.runGeneration !== intent.runGeneration || intent.id !== row.intentId || proof.owner !== row.owner || proof.runGeneration !== row.runGeneration || proof.attemptId !== row.id || proof.intentId !== intent.id || proof.protocol !== applyProtocol || proof.workerPid !== (row.processId ?? null) || proof.workerPid !== (intent.processId ?? null) || !Number.isFinite(Date.parse(proof.at))) return false;
  if (proof.state === 'job-quiescent') return Number.isSafeInteger(proof.workerPid) && proof.workerPid > 0 && Number.isSafeInteger(proof.guardPid) && proof.guardPid > 0;
  return proof.state === 'not-dispatched' && row.commandStarted !== true;
}
