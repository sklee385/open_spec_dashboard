import { afterAll, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { createApplication } from '../src/app';
import { createGateway } from '../src/gateway';
import { WorkStore } from '../src/work/store';

let engine: any, gateway: Server | undefined, releasePath: string | undefined;
async function closeGateway() { if (!gateway) return; const server = gateway; gateway = undefined; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
afterAll(async () => { if (releasePath) writeFileSync(releasePath, 'release'); await closeGateway(); await engine?.close(); for (const name of ['CONFIG_PATH', 'DATA_DIR', 'DESKTOP_TOKEN']) delete process.env[name]; });

it('새 프로젝트 API의 인증·질문 유지와 백그라운드 Git 작업의 종료 보류가 게이트웨이 교체 후에도 유지된다', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'project-gateway-')), root = join(fixture, 'project');
  const docs = join(root, 'openspec', 'changes', 'feature'); mkdirSync(join(docs, 'specs', 'feature'), { recursive: true });
  for (const path of ['proposal.md', 'design.md', 'tasks.md', 'specs/feature/spec.md']) writeFileSync(join(docs, path), '# Plan\n');
  writeFileSync(join(root, 'code.txt'), 'base');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'commit.gpgSign', 'false']); git(['add', '--', 'code.txt']); git(['commit', '-m', 'baseline']);
  process.env.CONFIG_PATH = join(fixture, 'config.json'); process.env.DATA_DIR = join(fixture, 'data'); process.env.DESKTOP_TOKEN = 'project-gateway-test-token';
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(root, 'openspec') }] }));
  engine = await createApplication(); await engine.listen(0, '127.0.0.1'); const port = Number(new URL(await engine.getUrl()).port);
  let base = '';
  const startGateway = async () => { gateway = createGateway(port, join(fixture, 'trash'), { token: process.env.DESKTOP_TOKEN }); await new Promise<void>(resolve => gateway!.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(gateway!.address() as any).port}`; };
  const api = async (path: string, method = 'GET', body?: unknown) => { const response = await fetch(`${base}/api/${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-desktop-token': process.env.DESKTOP_TOKEN! }, body: body === undefined ? undefined : JSON.stringify(body) }); return { code: response.status, data: await response.json() }; };
  await startGateway();
  expect((await fetch(`${base}/api/projects/demo/tree`)).status).toBe(401);
  expect((await api('projects/demo/file?path=code.txt')).data.content).toBe('base');
  const work = (await api('work', 'POST', { sourceId: 'demo', changeName: 'feature', requestKey: 'gateway-project' })).data;
  const store = engine.get(WorkStore); work.state = 'waiting-input'; store.save(work); store.record('question', work.id, 'question', { kind: 'input', status: 'pending', params: { questions: [{ id: 'q', question: 'fixture' }] } });
  await closeGateway(); await startGateway();
  const stillWaiting = (await api(`work/${work.id}`)).data;
  expect(stillWaiting.state).toBe('waiting-input'); expect(stillWaiting.questions[0].status).toBe('pending');
  expect((await api('projects/demo/entries', 'POST', { path: 'blocked.txt', kind: 'file' })).code).toBe(409);
  work.state = 'idle'; store.save(work); store.record('question', work.id, 'question', { kind: 'input', status: 'answered' });
  writeFileSync(join(root, 'code.txt'), 'changed'); git(['add', '--', 'code.txt']);
  const hookStarted = join(root, '.hook-started'); releasePath = join(root, '.release-commit');
  // The hook provides an event-based hold, not a timing assertion about Git speed.
  writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nprintf ready > .hook-started\nwhile [ ! -f .release-commit ]; do sleep 0.02; done\n', { mode: 0o755 });
  const status = (await api('projects/demo/git/status')).data;
  const started = await api('projects/demo/git/operations', 'POST', { kind: 'commit', token: status.token, requestKey: 'gateway-commit', message: 'gateway commit' });
  expect(started.code).toBe(202);
  await expect.poll(() => existsSync(hookStarted), { timeout: 10000 }).toBe(true);
  try {
    expect((await api('desktop/status')).data.idle).toBe(false);
    expect((await api('desktop/prepare', 'POST', {})).code).toBe(409);
    await closeGateway(); await startGateway();
    expect((await api(`projects/demo/git/operations/${started.data.id}`)).data.status).toBe('running');
  } finally { writeFileSync(releasePath, 'release'); }
  await expect.poll(async () => (await api(`projects/demo/git/operations/${started.data.id}`)).data.status, { timeout: 15000 }).toBe('succeeded');
  expect((await api('desktop/status')).data.idle).toBe(true);
}, 60000);
