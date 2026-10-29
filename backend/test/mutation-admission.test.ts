import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore, type Work } from '../src/work/store';
import { MutationAdmission } from '../src/work/mutation-admission';
let first: WorkStore, second: WorkStore;
const saved = process.env.DATA_DIR;
beforeEach(() => { process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ad-')); first = new WorkStore(); second = new WorkStore(); first.save({ id: 'a', requestKey: 'a', sourceId: 's', projectPath: '/fixture', changeName: 'a', ideaIds: [], phase: 'verification', state: 'idle', threadId: null, reviewedVersion: 'plan', createdAt: '', updatedAt: '' } as Work); });
afterEach(() => { first.onApplicationShutdown(); second.onApplicationShutdown(); if (saved === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = saved; });
const ticket = (store: WorkStore, fingerprint = 'body') => new MutationAdmission(store, 'a', 'fixture', 'key', fingerprint, () => store.records('a', 'business').length > 0);
it('preflight 확정 거부를 영속화하고 다른 WorkStore의 늦은 예약을 차단한다', async () => {
  const late = ticket(second); const failed = ticket(first);
  await expect(failed.run(async () => { throw new ConflictException('stale'); })).rejects.toMatchObject({ response: { mutationOutcome: 'rejected-before-intent', requestKey: 'key' } });
  expect(() => second.transaction(() => { late.admit(); second.record('business', 'a', 'business', {}); })).toThrow(); expect(second.records('a', 'business')).toEqual([]);
});
it('같은 DB의 다른 handler active preflight는 intent가 없어도 marker를 주지 않는다', async () => {
  let resume!: () => void; const pending = ticket(first).run(async admission => { await new Promise<void>(resolve => { resume = resolve; }); first.transaction(() => { admission.admit(); first.record('business', 'a', 'business', {}); }); return 'done'; });
  try { await ticket(second).run(async () => { throw new ConflictException('concurrent'); }); throw new Error('expected rejection'); } catch (error: any) { expect(error.getResponse()).not.toHaveProperty('mutationOutcome'); }
  resume(); expect(await pending).toBe('done'); expect(first.records('a', 'business')).toHaveLength(1);
});
it('business 예약과 admitted receipt는 같은 transaction이며 이후4xx는 unknown을 유지한다', async () => {
  await expect(ticket(first).run(async admission => { first.transaction(() => { admission.admit(); first.record('business', 'a', 'business', {}); }); throw new ConflictException('after commit'); })).rejects.not.toHaveProperty('response.mutationOutcome');
  expect(first.records('a', 'business')).toHaveLength(1); expect(first.records('a', 'mutation-admission')[0].status).toBe('admitted');
});
it('transaction rollback은 business/admitted를 모두 취소하고 확정 preflight 거부만 기록한다', async () => {
  await expect(ticket(first).run(async admission => { first.transaction(() => { admission.admit(); first.record('business', 'a', 'business', {}); throw new ConflictException('rolled back'); }); })).rejects.toHaveProperty('response.mutationOutcome', 'rejected-before-intent');
  expect(first.records('a', 'business')).toEqual([]); expect(first.records('a', 'mutation-admission')[0].status).toBe('rejected');
});
it('동일 key 다른 body와 기존 business 기록에는 marker를 붙이지 않는다', async () => {
  await ticket(first).run(async () => { throw new ConflictException('stale'); }).catch(() => {});
  await expect(ticket(second, 'different').run(async () => { throw new ConflictException('body'); })).rejects.not.toHaveProperty('response.mutationOutcome');
  first.record('business', 'a', 'business', {});
  await expect(ticket(second).run(async () => { throw new ConflictException('existing'); })).rejects.not.toHaveProperty('response.mutationOutcome');
});
it('5xx와 DB 확인 불명확에는 marker를 붙이지 않는다', async () => {
  await expect(ticket(first).run(async () => { throw new Error('unknown'); })).rejects.toThrow('unknown');
  const failure = vi.spyOn(first, 'transaction').mockImplementation(() => { throw new Error('DB unknown'); });
  await expect(ticket(first).run(async () => { throw new ConflictException('stale'); })).rejects.not.toHaveProperty('response.mutationOutcome'); failure.mockRestore();
});
it('workspace 경로 사전 거부 뒤 같은 key의 짧은 root 명시 재시도는 새 generation만 예약한다', async () => {
  const options = (context: string, basis = 'same-documents') => ({ retry: { context, basis, canRetry: () => first.records('a', 'business').length === 0, pathFailure: (error: any) => error.getResponse?.()?.errorCode === 'workspace-git-path-unsupported' } });
  const old = new MutationAdmission(second, 'a', 'workspace-prepare', 'key', 'body', () => second.records('a', 'business').length > 0, options('long-root'));
  await new MutationAdmission(first, 'a', 'workspace-prepare', 'key', 'body', () => false, options('long-root')).run(async () => { throw new ConflictException({ errorCode: 'workspace-git-path-unsupported' }); }).catch(() => {});
  let ran = false;
  await expect(new MutationAdmission(first, 'a', 'workspace-prepare', 'key', 'body', () => false, options('short-root')).run(async admission => { ran = true; first.transaction(() => { admission.admit(); first.record('business', 'a', 'business', {}); }); return 'ready'; })).resolves.toBe('ready');
  expect(ran).toBe(true); expect(first.records('a', 'mutation-admission')[0].generation).toBe(1); expect(() => second.transaction(() => old.admit())).toThrow();
});
it('workspace 같은 root 또는 달라진 문서 근거로는 rejected key의 generation을 갱신하지 않는다', async () => {
  const make = (context: string, basis: string) => new MutationAdmission(first, 'a', 'workspace-prepare', 'key', 'body', () => false, { retry: { context, basis, canRetry: () => true, pathFailure: () => true } });
  await make('long', 'docs').run(async () => { throw new ConflictException('path'); }).catch(() => {});
  const perform = vi.fn(async () => 'must not run');
  await make('long', 'docs').run(perform).catch(() => {}); await make('short', 'changed-docs').run(perform).catch(() => {});
  expect(perform).not.toHaveBeenCalled(); expect(first.records('a', 'mutation-admission')[0].generation).toBe(0);
});
