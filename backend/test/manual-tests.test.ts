import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Subject } from 'rxjs';
import { ExecutionService } from '../src/work/execution.service';
import { WorkStore, type Work } from '../src/work/store';
import type { LegacyService } from '../src/legacy/legacy.service';
import { relatedTestCommands } from '../src/work/test-commands';

const previous = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
let execution: ExecutionService, store: WorkStore;
afterEach(() => {
  execution?.onModuleDestroy(); store?.onApplicationShutdown();
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

it('Vitest workspace에서 소스 관련 테스트와 변경한 테스트 파일을 구분한다', () => {
  const { project } = setup();
  writeFileSync(join(project, 'package.json'), JSON.stringify({ workspaces: ['frontend'] }));
  mkdirSync(join(project, 'frontend')); writeFileSync(join(project, 'frontend/package.json'), JSON.stringify({ scripts: { 'test:run': 'vitest run --maxWorkers=1' } }));
  mkdirSync(join(project, 'frontend/src')); writeFileSync(join(project, 'frontend/src/view.test.tsx'), '');
  const commands = relatedTestCommands(project, ['frontend/src/view.tsx', 'frontend/src/view.test.tsx']);
  expect(commands).toHaveLength(2);
  expect(commands[0].args).toEqual(expect.arrayContaining(['related', 'src/view.tsx']));
  expect(commands[1].args).toEqual(expect.arrayContaining(['run', 'src/view.test.tsx']));
  expect(relatedTestCommands(project, [])).toEqual([]);
  expect(relatedTestCommands(project, ['frontend/package.json'])[0].args).not.toContain('related');
});
it('전체 테스트를 순차 실행하고 작업 테스트와 결과를 분리한다', async () => {
  const { work } = setup();
  work.verificationCommands = [command('first'), command('second')];
  work.workVerificationCommands = [command('focused')]; store.save(work);
  execution.runAll(work, 'work');
  expect(() => execution.runAll(store.get(work.id)!, 'full')).toThrow();
  await expect.poll(() => store.get(work.id)?.state).toBe('idle');
  expect(execution.results(work)).toMatchObject([{ commandId: 'focused', scope: 'work', status: 'passed', fresh: true }]);
  execution.runAll(store.get(work.id)!, 'full');
  await expect.poll(() => store.get(work.id)?.state).toBe('idle');
  expect(execution.results(work).map(row => [row.commandId, row.scope, row.status])).toEqual([['focused', 'work', 'passed'], ['first', 'full', 'passed'], ['second', 'full', 'passed']]);
  expect(execution.results(work).every(row => typeof row.durationMs === 'number')).toBe(true);
  writeFileSync(join(String(work.executionPath || work.projectPath), 'changed.txt'), 'next');
  expect(execution.results(work).every(row => !row.fresh)).toBe(true);
});
it('첫 실패와 사용자 중단 이후에는 남은 명령을 실행하지 않는다', async () => {
  const { work } = setup();
  work.verificationCommands = [command('fail', 1), command('skip')]; store.save(work);
  execution.runAll(work, 'full');
  await expect.poll(() => store.get(work.id)?.state).toBe('idle');
  expect(store.records(work.id, 'verification').map(row => row.commandId)).toEqual(['fail']);
  work.state = 'idle'; work.verificationCommands = [command('slow', 0, 3000), command('skip')]; store.save(work);
  execution.runAll(work, 'full'); expect(execution.interrupt(work.id)).toBe(true);
  await expect.poll(() => store.get(work.id)?.state).toBe('idle');
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
