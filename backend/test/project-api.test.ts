import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createApplication } from '../src/app';
import { WorkStore } from '../src/work/store';
import { ExecutionService } from '../src/work/execution.service';
import { projectCoordinator } from '../src/projects/coordinator';

let app: any, root: string, base: string, work: any;
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
beforeAll(async () => {
  const temp = mkdtempSync(join(tmpdir(), 'project-api-')); root = join(temp, 'source');
  const docs = join(root, 'openspec', 'changes', 'feature'); mkdirSync(join(docs, 'specs', 'feature'), { recursive: true });
  for (const file of ['proposal.md', 'design.md', 'tasks.md', 'specs/feature/spec.md']) writeFileSync(join(docs, file), '# Plan\n');
  writeFileSync(join(root, 'code.json'), '{"a":1}\r\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true });
  process.env.CONFIG_PATH = join(temp, 'config.json'); process.env.DATA_DIR = join(temp, 'data');
  process.env.CODEX_BIN = process.execPath; process.env.CODEX_ARGS = JSON.stringify([resolve('test/fixtures/codex.cjs')]);
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(root, 'openspec') }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  work = (await request('work', 'POST', { sourceId: 'demo', changeName: 'feature', requestKey: 'project-api' })).data;
});
afterAll(async () => { await app?.close(); for (const key of ['CONFIG_PATH', 'DATA_DIR', 'CODEX_BIN', 'CODEX_ARGS']) delete process.env[key]; });

it('등록 프로젝트의 원문과 파일 트리를 업무 실행 없이 조회한다', async () => {
  const tree = await request('projects/demo/tree'); expect(tree.status).toBe(200);
  expect(tree.data.entries.some((entry: any) => entry.path === 'code.json')).toBe(true);
  const file = await request('projects/demo/file?path=code.json');
  expect(file.data.content).toBe('{"a":1}\r\n'); expect(file.data.version).toMatch(/^[a-f0-9]{64}$/);
  expect((await request('projects/missing/tree')).status).toBe(404);
  expect((await request('projects/demo/file?path=../config.json')).status).toBe(400);
});

it('지원하는 큰 텍스트도 JSON body 한도에 막히지 않고 버전 기반 저장한다', async () => {
  const doc = (await request('projects/demo/file?path=code.json')).data;
  const content = 'x'.repeat(120000);
  const result = await request('projects/demo/file', 'PUT', { path: 'code.json', content, version: doc.version });
  expect(result.status).toBe(200); expect(readFileSync(join(root, 'code.json'), 'utf8')).toBe(content);
  expect((await request('projects/demo/file', 'PUT', { path: 'code.json', content: 'stale', version: doc.version })).status).toBe(409);
});

it('계획 문서 저장은 연결된 업무의 검토를 무효화한다', async () => {
  const store = app.get(WorkStore), current = store.get(work.id)!; current.reviewedVersion = 'reviewed'; store.save(current);
  const doc = (await request('projects/demo/file?path=openspec/changes/feature/proposal.md')).data;
  expect((await request('projects/demo/file', 'PUT', { ...doc, content: '# Revised\n' })).status).toBe(200);
  expect(store.get(work.id).reviewedVersion).toBeNull();
});

it('질문·승인 대기 중에는 직접 파일 저장도 서버에서 거부한다', async () => {
  const store = app.get(WorkStore), current = store.get(work.id)!; current.state = 'waiting-approval'; store.save(current);
  const doc = (await request('projects/demo/file?path=code.json')).data;
  expect((await request('projects/demo/file', 'PUT', { ...doc, content: 'blocked' })).status).toBe(409);
  current.state = 'idle'; store.save(current);
});

it('기존 업무 문서 저장도 AI 실행·검증 중에는 변경 조정 경계를 지킨다', async () => {
  const store = app.get(WorkStore), current = store.get(work.id)!;
  const doc = (await request(`work/${work.id}/document?path=proposal.md`)).data;
  current.state = 'running'; store.save(current);
  try {
    expect((await request(`work/${work.id}/document`, 'PUT', { ...doc, content: '# blocked' })).status).toBe(409);
    current.state = 'idle'; store.save(current);
    store.record('active-verification', work.id, 'verification', { status: 'running' });
    expect((await request(`work/${work.id}/document`, 'PUT', { ...doc, content: '# blocked' })).status).toBe(409);
    expect((await request(`work/${work.id}/document?path=proposal.md`)).data.content).toBe(doc.content);
  } finally {
    current.state = 'idle'; store.save(current);
    store.record('active-verification', work.id, 'verification', { status: 'passed' });
  }
});

it('파일·Git 변경 잠금 중에는 AI 턴과 검증을 시작하지 않는다', async () => {
  const store = app.get(WorkStore), current = store.get(work.id)!;
  current.verificationCommands = [{ id: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'] }]; store.save(current);
  const release = projectCoordinator(store).acquire(root);
  try {
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'plan' })).status).toBe(409);
    expect((await request(`work/${work.id}/verify`, 'POST', { commandId: 'test' })).status).toBe(409);
    expect(store.get(work.id).state).toBe('idle');
  } finally { release(); }
});

it('Git 변경 중 동일 대화 재연결도 기존 세션 상태를 바꾸지 않는다', async () => {
  const store = app.get(WorkStore), current = store.get(work.id)!; current.threadId = 'thread-for-reconnect'; store.save(current);
  const release = projectCoordinator(store).acquire(root);
  try {
    const result = await request(`work/${work.id}/reconnect`, 'POST', {});
    expect(result.status).toBe(409); expect(store.get(work.id).state).toBe('idle');
  } finally { release(); const latest = store.get(work.id); latest.threadId = null; latest.state = 'idle'; store.save(latest); }
});

it('파일 생성·이동·삭제를 버전과 확인값으로 수행한다', async () => {
  const created = await request('projects/demo/entries', 'POST', { path: 'new.txt', kind: 'file', content: 'new' });
  expect([200, 201]).toContain(created.status);
  const file = (await request('projects/demo/file?path=new.txt')).data;
  expect((await request('projects/demo/entries/move', 'POST', { path: 'new.txt', target: 'renamed.txt', version: file.version })).status).toBeLessThan(300);
  const moved = (await request('projects/demo/file?path=renamed.txt')).data;
  expect((await request('projects/demo/file', 'DELETE', { path: moved.path, version: moved.version })).status).toBe(400);
  expect((await request('projects/demo/file', 'DELETE', { path: moved.path, version: moved.version, confirmed: true })).status).toBe(200);
});

it('Git 오류는 HTTP 코드로 반환하고 임의 명령과 미등록 저장소 작업을 거부한다', async () => {
  const status = await request('projects/demo/git/status'); expect(status.status).toBe(200); expect(status.data.available).toBe(true);
  expect((await request('projects/demo/git/operations', 'POST', { kind: 'reset', token: status.data.token, requestKey: 'reset' })).status).toBe(400);
  expect((await request('projects/missing/git/status')).status).toBe(404);
});

it('같은 Git 요청은 실행 중이거나 끝난 뒤에도 같은 작업 ID를 반환한다', async () => {
  const status = (await request('projects/demo/git/status')).data;
  const body = { kind: 'stage', paths: ['code.json'], token: status.token, requestKey: 'idempotent-stage' };
  const [first, second] = await Promise.all([request('projects/demo/git/operations', 'POST', body), request('projects/demo/git/operations', 'POST', body)]);
  expect(first.status).toBe(202); expect(second.status).toBe(202); expect(second.data.id).toBe(first.data.id);
  await expect.poll(async () => (await request(`projects/demo/git/operations/${first.data.id}`)).data.status, { timeout: 15000 }).toBe('succeeded');
  const replay = await request('projects/demo/git/operations', 'POST', body); expect(replay.data.id).toBe(first.data.id);
  expect((await request('projects/demo/git/operations', 'POST', { ...body, paths: ['different.txt'] })).status).toBe(409);
}, 30000);

it('소스 화면 변경은 원본 해시가 같아도 별도 업무 검증의 최신성을 무효화한다', async () => {
  const store = app.get(WorkStore), execution = app.get(ExecutionService), current = store.get(work.id)!;
  const command = { id: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'] }; current.verificationCommands = [command]; store.save(current);
  execution.prepare(current);
  const revision = execution.revision(current);
  store.record('source-change-check', work.id, 'verification', { commandId: 'test', status: 'passed', revision, sourceMutationVersion: current.sourceMutationVersion, commandVersion: JSON.stringify(command) });
  expect(execution.results(current, revision).at(-1).fresh).toBe(true);
  const file = (await request('projects/demo/file?path=code.json')).data;
  expect((await request('projects/demo/file', 'PUT', file)).status).toBe(200);
  expect(execution.results(store.get(work.id), revision).at(-1).fresh).toBe(false);
});

it('연결 업무의 검증된 격리 공간을 선택하여 편집하고 원본을 보존한다', async () => {
  const store = app.get(WorkStore), current = store.get(work.id)!;
  const source = readFileSync(join(root, 'code.json'), 'utf8');
  writeFileSync(join(current.executionPath, 'code.json'), 'AI changed code\r\n');
  const query = `workId=${encodeURIComponent(work.id)}`;
  const file = await request(`projects/demo/file?path=code.json&${query}`);
  expect(file.status).toBe(200); expect(file.data.content).toBe('AI changed code\r\n');
  const saved = await request(`projects/demo/file?${query}`, 'PUT', { path: 'code.json', content: 'manual edit\r\n', version: file.data.version });
  expect(saved.status).toBe(200); expect(readFileSync(join(current.executionPath, 'code.json'), 'utf8')).toBe('manual edit\r\n');
  expect(readFileSync(join(root, 'code.json'), 'utf8')).toBe(source);
  expect((await request(`projects/demo/git/status?${query}`)).data.available).toBe(false);
  const before = store.get(work.id); before.reviewedVersion = 'reviewed-copy'; store.save(before);
  const doc = (await request(`projects/demo/file?path=openspec/changes/feature/proposal.md&${query}`)).data;
  expect((await request(`projects/demo/file?${query}`, 'PUT', { ...doc, content: '# Work plan updated\n' })).status).toBe(200);
  expect(store.get(work.id).reviewedVersion).toBeNull();
  expect((await request('projects/demo/tree?workId=missing')).status).toBe(404);
  store.save({ ...current, id: 'other-work', sourceId: 'other', requestKey: 'other', changeName: 'other' });
  expect((await request('projects/demo/tree?workId=other-work')).status).toBe(404);
  writeFileSync(join(current.executionPath, '..', 'identity.json'), JSON.stringify({ workId: 'foreign', projectPath: root }));
  expect((await request(`projects/demo/tree?${query}`)).status).toBe(409);
});

it('서버에 도달하지 않은 요청 키는 실제 상태 확인으로만 복구하고 재실행하지 않는다', async () => {
  const key = 'not-delivered-request';
  expect((await request(`projects/demo/git/operations/${key}`)).status).toBe(404);
  expect((await request(`projects/demo/git/operations/${key}/reconcile`, 'POST', {})).status).toBe(400);
  const confirmed = await request(`projects/demo/git/operations/${key}/reconcile`, 'POST', { confirmed: true });
  expect(confirmed.status).toBe(200);
  expect(confirmed.data.operation).toMatchObject({ id: key, status: 'uncertain', requestKey: key });
  expect(confirmed.data.operation.reviewedAt).toBeTruthy(); expect(confirmed.data.evidence.recordFound).toBe(false);
  expect((await request(`projects/demo/git/operations/${key}`)).status).toBe(404);
});

it('Git 실행 파일이 없어도 프로젝트 원문 편집·저장은 계속 사용할 수 있다', async () => {
  const previous = process.env.PATH; process.env.PATH = mkdtempSync(join(tmpdir(), 'project-without-git-'));
  try {
    const status = await request('projects/demo/git/status'); expect(status.data.available).toBe(false);
    const file = (await request('projects/demo/file?path=code.json')).data;
    const result = await request('projects/demo/file', 'PUT', { ...file, content: 'saved without git\n' });
    expect(result.status).toBe(200); expect(readFileSync(join(root, 'code.json'), 'utf8')).toBe('saved without git\n');
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});
