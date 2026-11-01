import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Subject } from 'rxjs';
import { ExecutionService } from '../src/work/execution.service';
import { WorkStore, type Work } from '../src/work/store';
import type { LegacyService } from '../src/legacy/legacy.service';
import { relatedTestCommands } from '../src/work/test-commands';

const previous = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
let execution: ExecutionService, store: WorkStore;
afterEach(async () => {
  await execution?.onModuleDestroy(); store?.onApplicationShutdown();
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'manual-tests-'));
  process.env.DATA_DIR = join(root, 'data'); process.env.WORKSPACE_ROOT = join(root, 'spaces');
  const project = join(root, 'project'); mkdirSync(project);
  const docs = join(project, 'openspec/changes/feature'); mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, 'tasks.md'), '- [x] implement\n');
  store = new WorkStore(); execution = new ExecutionService(store, { updates: new Subject<void>() } as LegacyService);
  const work = { id: 'w', sourceId: 'demo', projectPath: project, changeName: 'feature', requestKey: 'w', phase: 'implementation', state: 'idle', reviewedVersion: 'v1', ideaIds: [], threadId: null } as Work;
  store.save(work); execution.baseline(work);
  return { work, project: String(work.executionPath || work.projectPath) };
}
const command = (id: string, code = 0, delay = 0) => ({ id, command: process.execPath, args: ['-e', `setTimeout(() => {console.log('${id}'); process.exit(${code})}, ${delay})`] });

it('Vitest workspace에서 소스 관련 테스트와 변경한 테스트 파일을 중복 없이 합친다', () => {
  const { project } = setup();
  writeFileSync(join(project, 'package.json'), JSON.stringify({ workspaces: ['frontend'] }));
  mkdirSync(join(project, 'frontend')); writeFileSync(join(project, 'frontend/package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run --maxWorkers=1' } }));
  mkdirSync(join(project, 'frontend/src')); writeFileSync(join(project, 'frontend/src/view.test.tsx'), '');
  const commands = relatedTestCommands(project, ['frontend/src/view.tsx', 'frontend/src/view.test.tsx']);
  expect(commands).toHaveLength(1);
  expect(commands[0].args).toEqual(expect.arrayContaining(['related', 'src/view.tsx']));
  expect(commands[0].args).toEqual(expect.arrayContaining(['--run', 'src/view.test.tsx']));
  expect(relatedTestCommands(project, [])).toEqual([]);
  expect(relatedTestCommands(project, ['frontend/package.json'])[0].args).not.toContain('related');
});
it('전체 테스트를 순차 실행하고 작업 테스트와 결과를 분리한다', async () => {
  const { work } = setup();
  work.verificationCommands = [command('first'), command('second')];
  work.workVerificationCommands = [command('focused')]; store.save(work);
  execution.runAll(work, 'work');
  expect(() => execution.runAll(store.get(work.id)!, 'full')).toThrow();
  await expect.poll(() => store.get(work.id)?.state, { timeout: 15000 }).toBe('idle');
  expect(execution.results(work)).toMatchObject([{ commandId: 'focused', scope: 'work', status: 'passed', fresh: true }]);
  execution.runAll(store.get(work.id)!, 'full');
  await expect.poll(() => store.get(work.id)?.state, { timeout: 15000 }).toBe('idle');
  expect(execution.results(work).map(row => [row.commandId, row.scope, row.status])).toEqual([['focused', 'work', 'passed'], ['first', 'full', 'passed'], ['second', 'full', 'passed']]);
  expect(execution.results(work).every(row => typeof row.durationMs === 'number')).toBe(true);
  writeFileSync(join(String(work.executionPath || work.projectPath), 'changed.txt'), 'next');
  expect(execution.results(work).every(row => !row.fresh)).toBe(true);
});
it('첫 실패와 사용자 중단 이후에는 남은 명령을 실행하지 않는다', async () => {
  const { work } = setup();
  work.verificationCommands = [command('fail', 1), command('skip')]; store.save(work);
  execution.runAll(work, 'full');
  await expect.poll(() => store.get(work.id)?.state, { timeout: 15000 }).toBe('idle');
  expect(store.records(work.id, 'verification').map(row => row.commandId)).toEqual(['fail']);
  work.state = 'idle'; work.verificationCommands = [command('slow', 0, 3000), command('skip')]; store.save(work);
  execution.runAll(work, 'full'); expect(execution.interrupt(work.id)).toBe(true);
  await expect.poll(() => store.get(work.id)?.state, { timeout: 15000 }).toBe('idle');
  expect(store.records(work.id, 'verification').map(row => row.commandId)).toEqual(['fail', 'slow']);
});
it('작업 명령이 없으면 전체 검증으로 대체하거나 통과시키지 않는다', () => {
  const { work } = setup(); work.verificationCommands = [command('full')]; store.save(work);
  expect(() => execution.runAll(work, 'work')).toThrow();
  expect(store.records(work.id, 'verification')).toEqual([]);
  expect(() => execution.runAll(work, 'other' as any)).toThrow();
});
it('중첩 workspace의 설정 인자를 유지하고 자동 명령을 수동 계획에 저장할 수 있다', () => {
  const { work, project } = setup();
  writeFileSync(join(project, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  mkdirSync(join(project, 'packages/ui/src'), { recursive: true });
  writeFileSync(join(project, 'packages/ui/package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run --config "vitest.unit.config.ts" --project unit' } }));
  writeFileSync(join(project, 'packages/ui/src/view.ts'), 'export const value = 1;');
  const commands = execution.commands(work, 'work');
  expect(commands).toHaveLength(1);
  expect(commands[0].args).toEqual(expect.arrayContaining(['--config', 'vitest.unit.config.ts', '--project', 'unit']));
  expect(() => execution.setCommands(work, { scope: 'work', commands })).not.toThrow();
});

it('기능 config는 관련 검사, 공통 runner config는 넓은 검사로 분류한다', () => {
  const { project } = setup(); writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  expect(relatedTestCommands(project, ['src/config.ts', 'src/setup.ts', 'src/config.ts'])[0].args).toEqual(expect.arrayContaining(['related', 'src/config.ts', 'src/setup.ts']));
  expect(relatedTestCommands(project, ['vitest.config.ts'])[0].args).not.toContain('related');
  expect(relatedTestCommands(project, [{ path: 'package.json', before: '{"version":"1","scripts":{"test":"vitest run"}}', after: '{"version":"2","scripts":{"test":"vitest run"}}' }])).toEqual([]);
});
it('정확한 현재 정상 종료만 재사용하며 환경·최신 실패·미확인 종료는 다시 검사한다', async () => {
  const { work } = setup(); const check = command('proof'); work.verificationCommands = [check]; store.save(work);
  const first = execution.run(work, 'proof'); await expect.poll(() => store.get(work.id)?.state, { timeout: 15000 }).toBe('idle');
  const current = store.get(work.id)!;
  expect(execution.run(current, 'proof')).toMatchObject({ id: first.id, reused: true });
  expect(store.records(work.id, 'verification')).toHaveLength(1);
  const saved = process.env.OPENSPEC_TEST_CONTEXT; process.env.OPENSPEC_TEST_CONTEXT = 'changed';
  try { expect(execution.results(current).at(-1)!.fresh).toBe(false); }
  finally { if (saved === undefined) delete process.env.OPENSPEC_TEST_CONTEXT; else process.env.OPENSPEC_TEST_CONTEXT = saved; }
  const proof = store.records(work.id, 'verification').at(-1)!;
  store.record('unknown-proof', work.id, 'verification', { ...proof, processTerminated: false });
  expect(execution.results(current).at(-1)!.fresh).toBe(false);
  expect(() => execution.run(current, 'proof')).toThrow();
  store.record('unknown-proof', work.id, 'verification', { ...proof, status: 'interrupted', processTerminated: true });
  store.record('later-failure', work.id, 'verification', { ...proof, status: 'failed' });
  const retry = execution.run(current, 'proof'); expect(retry.id).not.toBe(first.id);
  await expect.poll(() => store.get(work.id)?.state, { timeout: 15000 }).toBe('idle');
});
it('검사 계획은 변경 관련을 기본으로 하고 명시 선택과 같은 명령 중복 제거를 유지한다', () => {
  const { work } = setup(); expect(execution.requiredPlan(work)).toMatchObject({ scope: 'work', commands: [] });
  const check = command('once'); execution.setCommands(work, { scope: 'work', commands: [check, { ...check, id: 'alias' }] });
  expect(execution.requiredPlan(work).commands).toHaveLength(1);
  execution.setCommands(work, { scope: 'full', commands: [check] }); expect(execution.requiredPlan(work).scope).toBe('full');
});

it('정상 종료에서 확인한 Job 종료를 저장하여 재시작 후 가짜 실행 잠김을 남기지 않는다', async () => {
  const { work, project } = setup();
  const marker = join(project, 'shutdown-started.txt');
  work.verificationCommands = [{ id: 'shutdown', command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(()=>{}, 1000)`] }]; store.save(work);
  execution.run(work, 'shutdown');
  await expect.poll(() => existsSync(marker), { timeout: 15000 }).toBe(true);
  await execution.onModuleDestroy();
  const stopped = store.records(work.id, 'verification').at(-1)!;
  expect(stopped).toMatchObject({ status: 'interrupted', processTerminated: true, terminationEvidence: 'job-and-worker-closed' });
  expect(store.get(work.id)?.state).toBe('idle');
  execution = new ExecutionService(store, { updates: new Subject<void>() } as LegacyService);
  const current = store.get(work.id)!; current.verificationCommands = [command('after-restart')]; store.save(current);
  execution.run(current, 'after-restart');
  await expect.poll(() => store.records(work.id, 'verification').at(-1)?.status, { timeout: 15000 }).toBe('passed');
}, 30000);
