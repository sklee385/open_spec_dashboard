import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore, type Work } from '../src/work/store';
import { BrowserService } from '../src/browser/browser.service';
import { VerificationSnapshots } from '../src/browser/verification-snapshot';
import * as git from '../src/projects/git-runner';

let store: WorkStore, browser: BrowserService, work: Work;
const saved = { DATA_DIR: process.env.DATA_DIR, CONFIG_PATH: process.env.CONFIG_PATH };
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'bstat-')); process.env.DATA_DIR = join(dir, 'data'); process.env.CONFIG_PATH = join(dir, 'config.json'); writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [] })); mkdirSync(join(dir, 'source'));
  store = new WorkStore(); work = { id: 'a', sourceId: 'fixture', projectPath: join(dir, 'source'), changeName: 'a', requestKey: 'a', ideaIds: [], phase: 'verification', state: 'idle', threadId: 'thread', reviewedVersion: null, browserScenario: { name: 'fixture', server: { command: 'node', args: ['server.cjs'], url: 'http://127.0.0.1:19231' }, steps: [{ op: 'expectURL', path: '/' }] }, createdAt: '', updatedAt: '' }; store.save(work); browser = new BrowserService(store);
});
afterEach(async () => { vi.restoreAllMocks(); await browser.onModuleDestroy(); store.onApplicationShutdown(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
it('기본 status는 namespace SQL LIMIT10과 DB/live만 읽고 Git·전체FS·전체records를 읽지 않는다', async () => {
  for (let index = 0; index < 24; index++) store.record('work-'+index, work.id, 'browser-verification', { status: 'passed', candidateId: null, targetKind: 'work', requestKey: 'request-'+index, expectedVersion: 'expected-'+index, processTerminated: true });
  store.record('candidate-latest', work.id, 'browser-verification', { status: 'passed', candidateId: 'candidate-a', targetKind: 'integration-candidate' });
  const records = vi.spyOn(store, 'records').mockImplementation(() => { throw new Error('unbounded records read'); }), identity = vi.spyOn(browser, 'identity'), revision = vi.spyOn(VerificationSnapshots.prototype, 'revision'), sync = vi.spyOn(git, 'readGitSync'), run = vi.spyOn(git, 'runGit'), sql = vi.spyOn(store.db, 'prepare');
  const status = await browser.status(work.id);
  expect(status.observation.state).toBe('not-checked'); expect(status.results).toHaveLength(10); expect(status.results.at(-1)).toMatchObject({ id: 'work-23', requestKey: 'request-23', expectedVersion: 'expected-23', processTerminated: true, fresh: false, freshnessState: 'not-checked' });
  expect(status.results.some(row => row.candidateId)).toBe(false); expect(sql.mock.calls.some(([query]) => /LIMIT\s+10/i.test(String(query)))).toBe(true);
  expect(records).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled(); expect(revision).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
});
it('후보 cheap status는 같은 업무의 해당 후보 기록만 보존한다', async () => {
  for (const candidateId of [null, 'candidate-a', 'candidate-b']) store.record('row-'+candidateId, work.id, 'browser-verification', { status: 'passed', candidateId, targetKind: candidateId ? 'integration-candidate' : 'work', requestKey: 'kept', candidateVersion: 'version', processTerminated: true });
  const status = await browser.status(work.id, false, 'candidate-a'); expect(status.results).toHaveLength(1); expect(status.results[0]).toMatchObject({ id: 'row-candidate-a', candidateId: 'candidate-a', requestKey: 'kept', candidateVersion: 'version', processTerminated: true, fresh: false }); expect(status.observation.state).toBe('not-checked');
});
it('구형 passed는 raw revision이 같아도 빌드·환경·종료 evidence 없이 fresh와 완료 근거가 되지 않는다', async () => {
  const identity = { ...(browser as any).context(work), revision: 'same-source', targetVersion: 'same-target' };
  vi.spyOn(browser, 'identity').mockResolvedValue(identity);
  store.record('legacy-pass', work.id, 'browser-verification', { ...identity, status: 'passed', candidateId: null, targetKind: 'work' });
  await expect(browser.assertPassed(work)).rejects.toThrow(); const inspected = await browser.status(work.id, true); expect(inspected.results[0].fresh).toBe(false); expect(inspected.observation.state).toBe('stale'); expect(inspected.results[0].status).toBe('passed');
});
