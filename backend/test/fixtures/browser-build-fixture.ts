import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkStore, type Work } from '../../src/work/store';
import { LegacyService } from '../../src/legacy/legacy.service';
import { ProjectResolver } from '../../src/projects/resolver';
import { VerificationEnvironments } from '../../src/browser/verification-environment';
import { VerificationSnapshots } from '../../src/browser/verification-snapshot';
import { runScenario } from '../../src/browser/browser-runner';
import type { Scenario } from '../../src/browser/browser-policy';

/** Preserve the old scenario behavior while providing the new fresh-build source contract. */
export function browserBuildFixture(root: string, change = 'browser') {
  mkdirSync(join(root, 'openspec/changes', change, 'specs/demo'), { recursive: true });
  for (const file of ['proposal.md', 'design.md', 'tasks.md', 'specs/demo/spec.md']) writeFileSync(join(root, 'openspec/changes', change, file), '# fixture plan\n');
  writeFileSync(join(root, 'fixture-input.js'), 'window.__freshFixtureBuild=true;\n');
  writeFileSync(join(root, 'build.cjs'), "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('fixture-input.js','dist/fixture-app.js');\n");
  writeFileSync(join(root, 'openspec/browser-build.json'), JSON.stringify({ version: 1, build: { command: 'node', args: ['build.cjs'] }, artifacts: [{ path: 'dist/fixture-app.js', urlPath: '/__fixture-build.js' }], identity: { path: 'dist/fixture-identity.json', urlPath: '/__fixture-identity.json' } }));
}
export function browserFixtureConfig(root: string, sourceId: string) {
  const config = join(mkdtempSync(join(tmpdir(), 'bcfg-')), 'config.json');
  writeFileSync(config, JSON.stringify({ sources: [{ name: sourceId, path: join(root, 'openspec') }] })); process.env.CONFIG_PATH = config;
}

/** Low-level runner regressions get a fresh owned copy per invocation, including repeat runs.
 * The service integration suite separately exercises the actual worker/Job boundary.
 */
export async function runBrowserFixture(scenario: Scenario, source: string, signal: AbortSignal) {
  if (signal.aborted) return runScenario(scenario, source, signal);
  const previous = { DATA_DIR: process.env.DATA_DIR, CONFIG_PATH: process.env.CONFIG_PATH, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT };
  const dir = mkdtempSync(join(tmpdir(), 'brun-')), copy = join(dir, 'copy/project'); process.env.DATA_DIR = join(dir, 'data'); delete process.env.WORKSPACE_ROOT; browserFixtureConfig(source, 'fixture');
  const store = new WorkStore(), legacy = new LegacyService(), snapshots = new VerificationSnapshots(store);
  let snapshot: Awaited<ReturnType<VerificationSnapshots['prepare']>> | undefined;
  try {
    mkdirSync(dirname(copy), { recursive: true }); cpSync(source, copy, { recursive: true });
    const work: Work = { id: 'runner', sourceId: 'fixture', projectPath: source, executionPath: copy, changeName: 'browser', requestKey: 'runner', ideaIds: [], phase: 'verification', state: 'idle', threadId: null, reviewedVersion: null, browserScenario: scenario, createdAt: '', updatedAt: '' }; store.save(work);
    store.record('baseline', work.id, 'isolated-baseline', { executionPath: copy }); writeFileSync(join(dirname(copy), 'identity.json'), JSON.stringify({ workId: work.id, projectPath: source }));
    const proof = await new VerificationEnvironments(store, new ProjectResolver(legacy, store)).capture({ sourceId: 'fixture', workId: work.id });
    snapshot = await snapshots.prepare(work, copy, signal, proof.environment);
    return await runScenario(scenario, snapshot.root, signal, () => {}, { snapshot, environment: proof.environment });
  } finally {
    if (snapshot) await snapshots.cleanup(snapshot); await legacy.onModuleDestroy(); store.onApplicationShutdown();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
