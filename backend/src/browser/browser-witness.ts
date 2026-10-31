import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkStore } from '../work/store';
import type { BrowserTermination } from './browser-lease';

// This capability is stored only in host data, never in the writable verification copy.
export type BrowserWitness = { file: string; nonce: string; identity?: string };
const identity = (stat: ReturnType<typeof fstatSync>) => createHash('sha256').update(`${stat.dev}:${stat.ino}`).digest('hex');
function directory(store: WorkStore) {
  const db = (store.db.prepare('PRAGMA database_list').all() as any[]).find(row => row.name === 'main')?.file;
  if (!db) throw new Error('브라우저 종료 기록의 데이터 경로가 없습니다');
  const parent = realpathSync(dirname(db)), folder = join(parent, 'browser-termination');
  mkdirSync(folder, { recursive: true });
  if (lstatSync(folder).isSymbolicLink() || realpathSync(folder).toLowerCase() !== folder.toLowerCase()) throw new Error('브라우저 종료 기록 경계가 변경됐습니다');
  return folder;
}
export function prepareBrowserWitness(store: WorkStore): BrowserWitness {
  const nonce = randomBytes(32).toString('hex');
  return { file: join(directory(store), `${nonce}.receipt`), nonce };
}
function read(store: WorkStore, witness: BrowserWitness) {
  if (!witness || !/^[a-f0-9]{64}$/.test(witness.nonce) || witness.file !== join(directory(store), `${witness.nonce}.receipt`)) throw new Error('브라우저 종료 기록 소유권이 다릅니다');
  const before = lstatSync(witness.file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 512) throw new Error('브라우저 종료 기록 파일이 잘못됐습니다');
  const fd = openSync(witness.file, constants.O_RDONLY);
  try {
    const stat = fstatSync(fd);
    if (identity(stat) !== identity(before) || witness.identity && identity(stat) !== witness.identity || stat.nlink !== 1 || stat.size > 512) throw new Error('브라우저 종료 기록 파일이 교체됐습니다');
    const bytes = Buffer.alloc(513), count = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('브라우저 종료 기록을 읽는 중 변경됐습니다');
    return { lines: bytes.subarray(0, count).toString('utf8').trim().split('\n').map(line => line.trim()), identity: identity(stat) };
  } finally { closeSync(fd); }
}
export function bindBrowserWitness(store: WorkStore, witness: BrowserWitness, workerPid: number, guardPid: number) {
  const observed = read(store, witness);
  if (observed.lines.length !== 5 || !['READY', 'QUIESCENT'].includes(observed.lines[0]) || observed.lines[1] !== witness.nonce || observed.lines[2] !== String(workerPid) || observed.lines[3] !== String(guardPid)) throw new Error('소유 가드의 종료 기록 준비를 확인하지 못했습니다');
  return { ...witness, identity: observed.identity };
}
export function recoverBrowserWitness(store: WorkStore, row: any, slot: any, intent: any): BrowserTermination | undefined {
  try {
    const witness = row.terminationWitness as BrowserWitness;
    if (!witness?.identity || !row.dispatched || row.executionOwner !== slot?.owner || row.runGeneration !== slot?.runGeneration || row.id !== slot?.runId || row.workId !== slot?.workId || slot.protocol !== row.executionProtocol || row.executionProtocol !== 'browser-job-v2' || !intent || intent.owner !== row.executionOwner || intent.runGeneration !== row.runGeneration || intent.runId !== row.id || intent.executionProtocol !== row.executionProtocol) return;
    for (const receipt of [slot, intent]) if (JSON.stringify(receipt.terminationWitness) !== JSON.stringify(witness) || receipt.processId !== row.processId || receipt.guardPid !== row.guardPid) return;
    const { lines } = read(store, witness);
    if (lines.length !== 5 || lines[0] !== 'QUIESCENT' || lines[1] !== witness.nonce || lines[2] !== String(row.processId) || lines[3] !== String(row.guardPid) || !Number.isFinite(Date.parse(lines[4])) || !Number.isSafeInteger(row.processId) || row.processId <= 0 || !Number.isSafeInteger(row.guardPid) || row.guardPid <= 0) return;
    return { protocol: 'browser-job-v2', owner: row.executionOwner, runGeneration: row.runGeneration, runId: row.id, workId: row.workId, state: 'job-quiescent', workerPid: row.processId, guardPid: row.guardPid, activeProcesses: 0, at: lines[4] };
  } catch { return undefined; }
}
