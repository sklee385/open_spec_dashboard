import { ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { WorkStore } from '../work/store';
import type { VerificationSnapshot } from './verification-snapshot';

export const browserProtocol = 'browser-job-v2';
export const browserSettlementMs = 10000;
const host = randomUUID(), slotId = 'browser-global-slot';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type BrowserTermination = { protocol: typeof browserProtocol; owner: string; runGeneration: string; runId: string; workId: string; state: 'not-started' | 'worker-closed-before-dispatch' | 'job-quiescent'; workerPid: number | null; guardPid: number | null; activeProcesses?: number; at: string };
export type LiveBrowser = { database: string; workId: string; runId: string; owner: string; runGeneration: string; expected: string; phase: 'active' | 'uncertain'; proof?: BrowserTermination; snapshot?: VerificationSnapshot; releaseScope?: () => void; reconciling?: boolean };
const live = new Set<LiveBrowser>();
const databases = new WeakMap<WorkStore, string>();
function database(store: WorkStore) { const saved = databases.get(store); if (saved) return saved; const file = (store.db.prepare('PRAGMA database_list').all() as { file: string }[]).find(row => row.file)?.file ?? ''; const path = realpathSync(file), value = process.platform === 'win32' ? path.toLowerCase() : path; databases.set(store, value); return value; }
export function browserRecord(store: WorkStore, id: string) { const row = store.db.prepare('SELECT id,work_id,kind,data FROM records WHERE id=?').get(id) as any; return row ? { ...JSON.parse(row.data), id: row.id, workId: row.work_id } : undefined; }
export const browserSlot = (store: WorkStore) => browserRecord(store, slotId);
function matches(row: any, slot: any) { return !!row && !!slot && row.id === slot.runId && row.workId === slot.workId && row.executionOwner === slot.owner && row.runGeneration === slot.runGeneration && row.executionProtocol === browserProtocol && slot.protocol === browserProtocol; }
function tuple(store: WorkStore, row: any) { return digest([browserRecord(store, row.id), browserSlot(store), browserRecord(store, row.intentId)]); }
function saveSlot(store: WorkStore, slot: any) { store.db.prepare("INSERT INTO records(id,work_id,kind,data) VALUES(?,?,'browser-slot',?) ON CONFLICT(id) DO UPDATE SET work_id=excluded.work_id,kind=excluded.kind,data=excluded.data").run(slotId, slot.workId, JSON.stringify(slot)); }
export function liveBrowser(store: WorkStore, workId?: string) { const file = database(store), slot = browserSlot(store); return [...live].find(entry => entry.database === file && (workId === undefined || entry.workId === workId) && entry.runId === slot?.runId && entry.owner === slot?.owner && entry.runGeneration === slot?.runGeneration); }
export function claimBrowser(store: WorkStore, row: any, admitted: () => void) {
  const entry: LiveBrowser = { database: database(store), workId: row.workId, runId: row.id, owner: host, runGeneration: randomUUID(), expected: '', phase: 'active' };
  Object.assign(row, { executionProtocol: browserProtocol, executionOwner: entry.owner, runGeneration: entry.runGeneration, intentId: `${row.id}:snapshot`, processTerminated: false, dispatched: false });
  entry.expected = store.transaction(() => {
    const existing = browserSlot(store);
    if (existing && existing.status !== 'settled') throw new ConflictException('다른 브라우저 검증이 진행 중이거나 실제 종료 확인이 필요합니다');
    if (store.db.prepare("SELECT 1 FROM records WHERE kind='browser-verification' AND (json_extract(data,'$.status')='running' OR json_extract(data,'$.cleanupStatus')='uncertain') LIMIT 1").get()) throw new ConflictException('이전 브라우저 실행의 실제 종료 확인이 필요합니다');
    store.record(row.id, row.workId, 'browser-verification', row); saveSlot(store, { workId: row.workId, runId: row.id, owner: entry.owner, runGeneration: entry.runGeneration, protocol: browserProtocol, status: 'running', processTerminated: false }); admitted(); return tuple(store, row);
  });
  live.add(entry); return entry;
}
export function assertBrowserLease(store: WorkStore, entry: LiveBrowser, row: any) {
  const slot = browserSlot(store); if (!matches(row, slot) || slot.status === 'settled' || tuple(store, row) !== entry.expected) throw new ConflictException('브라우저 실행 소유 세대 또는 영수증이 변경되었습니다');
}
/** Adopt the expected tuple only after this transaction commits successfully. */
export function checkpointBrowser(store: WorkStore, entry: LiveBrowser, row: any, options: { snapshot?: VerificationSnapshot; intent?: any; status?: 'running' | 'uncertain' | 'settled'; updateWork?: () => void } = {}) {
  const expected = store.transaction(() => {
    assertBrowserLease(store, entry, row); const slot = browserSlot(store), intent = options.intent ?? browserRecord(store, row.intentId);
    store.record(row.id, row.workId, 'browser-verification', row);
    if (intent) store.record(row.intentId, row.workId, 'workspace-git-intent', { ...intent, owner: entry.owner, runGeneration: entry.runGeneration, runId: row.id, executionProtocol: browserProtocol, processId: row.processId ?? null, guardPid: row.guardPid ?? null, terminationWitness: row.terminationWitness, processTerminated: row.processTerminated === true, ...(row.terminationProof ? { terminationProof: row.terminationProof } : {}) });
    saveSlot(store, { ...slot, status: options.status ?? slot.status, snapshot: options.snapshot ?? row.snapshot ?? slot.snapshot, processId: row.processId ?? null, guardPid: row.guardPid ?? null, terminationWitness: row.terminationWitness, processTerminated: row.processTerminated === true, ...(row.terminationProof ? { terminationProof: row.terminationProof } : {}) }); options.updateWork?.();
    return tuple(store, row);
  });
  entry.expected = expected; if (options.snapshot) entry.snapshot = options.snapshot;
}
export function browserTerminationValid(row: any, slot: any, intent?: any) {
  const proof = row?.terminationProof;
  if (!matches(row, slot) || row.processTerminated !== true || slot.processTerminated !== true || !proof || JSON.stringify(proof) !== JSON.stringify(slot.terminationProof) || proof.protocol !== browserProtocol || proof.owner !== row.executionOwner || proof.runGeneration !== row.runGeneration || proof.runId !== row.id || proof.workId !== row.workId || proof.workerPid !== (row.processId ?? null) || proof.guardPid !== (row.guardPid ?? null) || proof.workerPid !== (slot.processId ?? null) || proof.guardPid !== (slot.guardPid ?? null) || !Number.isFinite(Date.parse(proof.at))) return false;
  if (intent && (intent.owner !== row.executionOwner || intent.runGeneration !== row.runGeneration || intent.runId !== row.id || intent.executionProtocol !== browserProtocol || intent.processTerminated !== true || proof.workerPid !== (intent.processId ?? null) || proof.guardPid !== (intent.guardPid ?? null) || JSON.stringify(intent.terminationProof) !== JSON.stringify(proof))) return false;
  if (proof.state === 'not-started') return row.workerSpawned !== true && row.dispatched !== true && proof.workerPid === null;
  if (proof.state === 'worker-closed-before-dispatch') return row.workerClosed === true && row.dispatched !== true;
  return proof.state === 'job-quiescent' && row.workerClosed === true && proof.activeProcesses === 0 && Number.isSafeInteger(proof.workerPid) && proof.workerPid > 0 && Number.isSafeInteger(proof.guardPid) && proof.guardPid > 0;
}
export function proofForBrowser(entry: LiveBrowser, row: any, fields: Pick<BrowserTermination, 'state'> & { activeProcesses?: number }): BrowserTermination { return { protocol: browserProtocol, owner: entry.owner, runGeneration: entry.runGeneration, runId: row.id, workId: row.workId, workerPid: row.processId ?? null, guardPid: row.guardPid ?? null, at: new Date().toISOString(), ...fields }; }
export function finishBrowserLease(store: WorkStore, entry: LiveBrowser, row: any, settled: boolean, updateWork?: () => void) {
  const old = browserRecord(store, row.intentId);
  checkpointBrowser(store, entry, row, { status: settled ? 'settled' : 'uncertain', updateWork, ...(old ? { intent: { ...old, status: settled ? row.status === 'passed' ? 'passed' : row.status : 'uncertain' } } : {}) });
  if (settled) { entry.releaseScope?.(); entry.releaseScope = undefined; live.delete(entry); } else entry.phase = 'uncertain';
}
export function recoverBrowserLease(store: WorkStore, row: any) {
  const observed = store.transaction(() => { const slot = browserSlot(store); if (!matches(row, slot) || !['running', 'uncertain'].includes(slot.status) || digest(browserRecord(store, row.id)) !== digest(row)) throw new ConflictException('현재 미확인 브라우저 세대만 복구할 수 있습니다'); return { slot, expected: tuple(store, row) }; });
  const slot = observed.slot;
  const existing = liveBrowser(store, row.workId);
  if (existing?.phase === 'active' || existing?.reconciling) throw new ConflictException('소유 브라우저 실행 또는 복구가 진행 중입니다');
  const entry: LiveBrowser = existing ?? { database: database(store), workId: row.workId, runId: row.id, owner: row.executionOwner, runGeneration: row.runGeneration, expected: observed.expected, phase: 'uncertain', snapshot: slot.snapshot };
  // An explicit new recovery observes the current tuple; an old finalizer never does.
  entry.expected = observed.expected;
  if (!existing) live.add(entry); return entry;
}
