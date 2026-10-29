import { ConflictException } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Work, WorkStore } from '../work/store';

export type RuntimeState = 'active' | 'inactive' | 'unknown';
const registries = new WeakMap<WorkStore, DesktopHealth>();
const busy = new Set(['running', 'connecting', 'creating-thread', 'waiting-input', 'waiting-approval', 'recovery-required']);
const eventTypes = new Set(['safe-mode-enabled', 'safe-mode-disabled', 'work-recovered', 'codex-disconnected', 'execution-failed', 'interrupt-requested', 'history-storage-failed']);
const eventStates = new Set(['idle', 'failed', 'interrupted', 'recovery-required']);
const errorCodes = new Set(['thread-in-use', 'connection-failed', 'codex-disconnected', 'session-restarted', 'external-restarted', 'missing-executable', 'authentication-failed', 'execution-failed', 'timeout', 'output-limit', 'interrupted', 'termination-unconfirmed', 'argument-limit', 'verification-failed']);
export function desktopHealth(store: WorkStore) {
  let health = registries.get(store);
  if (!health) { health = new DesktopHealth(); registries.set(store, health); }
  return health;
}
class DesktopHealth {
  private probes = new Map<string, (work: Work) => RuntimeState | undefined>();
  private interruptProbes = new Map<string, (work: Work) => boolean>();
  private path = join(resolve(process.env.DATA_DIR || '../.data'), 'desktop-health.json');
  safeMode = false;
  history: { type: string; workId?: string; state?: string; errorCode?: string; at: string }[] = [];
  constructor() {
    try {
      if (existsSync(this.path)) {
        const saved = JSON.parse(readFileSync(this.path, 'utf8')); this.safeMode = saved.safeMode !== false;
        this.history = Array.isArray(saved.history) ? saved.history.slice(-100).filter((row: any) => eventTypes.has(row?.type) && typeof row.at === 'string').map((row: any) => ({ type: row.type, at: row.at, ...(typeof row.workId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(row.workId) ? { workId: row.workId } : {}), ...(eventStates.has(row.state) ? { state: row.state } : {}), ...(errorCodes.has(row.errorCode) ? { errorCode: row.errorCode } : {}) })) : [];
      }
    }
    catch { this.safeMode = true; }
    if (process.env.OPENSPEC_SAFE_MODE === '1') this.setSafeMode(true);
  }
  register(kind: string, probe: (work: Work) => RuntimeState | undefined) { this.probes.set(kind, probe); }
  registerInterrupt(kind: string, probe: (work: Work) => boolean) { this.interruptProbes.set(kind, probe); }
  canInterrupt(work: Work) { return [...this.interruptProbes.values()].some(probe => probe(work)); }
  runtime(work: Work): RuntimeState {
    const states = [...this.probes.values()].map(probe => probe(work)).filter(Boolean);
    if (states.includes('active')) return 'active';
    if (states.includes('unknown')) return 'unknown';
    if (states.includes('inactive')) return 'inactive';
    return !['completed', 'archived'].includes(work.phase) && busy.has(work.state) ? 'unknown' : 'inactive';
  }
  assertExecutionAllowed() { if (this.safeMode) throw new ConflictException('안전 모드에서는 새 실행을 보류합니다. 진단 창에서 해제해 주세요.'); }
  setSafeMode(enabled: boolean) {
    this.persist(enabled);
    this.safeMode = enabled;
    this.event(enabled ? 'safe-mode-enabled' : 'safe-mode-disabled');
  }
  event(type: string, workId?: string, state?: string, errorCode?: string) {
    if (!eventTypes.has(type)) return;
    this.history.push({ type, ...(workId && /^[a-zA-Z0-9-]{1,128}$/.test(workId) ? { workId } : {}), ...(state && eventStates.has(state) ? { state } : {}), ...(errorCode && errorCodes.has(errorCode) ? { errorCode } : {}), at: new Date().toISOString() });
    this.history = this.history.slice(-100);
    try { this.persist(this.safeMode); }
    catch { this.history.push({ type: 'history-storage-failed', at: new Date().toISOString() }); this.history = this.history.slice(-100); }
  }
  private persist(safeMode: boolean) {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify({ safeMode, history: this.history }), { encoding: 'utf8', mode: 0o600 }); renameSync(temporary, this.path);
  }
}
