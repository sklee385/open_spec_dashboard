import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkStore } from '../src/work/store';

let app: INestApplication, base: string, root: string, counter = 0;
async function request(path: string, body?: unknown, method = 'POST') {
  const res = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
async function work(mode = 'echo', extra: any = {}) {
  const config = (await request('ai-tools')).data;
  expect((await request('ai-tools', { ...config, defaultToolId: 'cli', tools: [config.tools[0], { id: 'cli', name: '테스트 CLI', kind: 'external-cli', executable: process.execPath, args: [resolve('test/fixtures/external-cli.cjs'), mode], input: 'stdin', timeoutMs: 10000, ...extra }] }, 'PUT')).status).toBe(200);
  const name = `work-${++counter}`, dir = join(root, 'openspec', 'changes', name);
  await mkdir(join(dir, 'specs', 'test'), { recursive: true });
  for (const path of ['proposal.md', 'design.md', 'tasks.md', 'specs/test/spec.md']) await writeFile(join(dir, path), `# ${name} ${path}\n최신 문서`);
  return (await request('work', { sourceId: 'demo', changeName: name, requestKey: name })).data;
}
const state = async (id: string) => (await request(`work/${id}`)).data;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'external-cli-')); await mkdir(join(root, 'openspec'));
  process.env.CONFIG_PATH = join(root, 'config.json'); process.env.DATA_DIR = join(root, 'data');
  await writeFile(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: './openspec' }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
});
afterAll(async () => { await app.close(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; });
it('설정 저장은 실행하지 않으며 stdin에 같은 업무 대화와 최신 문서·계획 제한을 전달한다', async () => {
  const w = await work(); expect((await state(w.id)).events).toHaveLength(1);
  expect((await request(`work/${w.id}/message`, { text: '첫 요청' })).status).toBe(200);
  await expect.poll(async () => (await state(w.id)).state, { timeout: 5000 }).toBe('idle');
  await writeFile(join(root, 'openspec', 'changes', w.changeName, 'proposal.md'), '# 수정된 최신 내용');
  await request(`work/${w.id}/message`, { text: '후속 요청' });
  await expect.poll(async () => (await state(w.id)).state, { timeout: 5000 }).toBe('idle');
  const output = (await state(w.id)).events.filter((e: any) => e.type === 'item/agentMessage/delta').map((e: any) => e.data.delta).join('');
  for (const text of ['첫 요청', '후속 요청', '수정된 최신 내용', '제품 코드를 구현하지 않는다', w.id]) expect(output).toContain(text);
  const other = await work(); await request(`work/${other.id}/message`, { text: '다른 업무' });
  await expect.poll(async () => (await state(other.id)).state, { timeout: 5000 }).toBe('idle');
  expect(JSON.stringify((await state(other.id)).events)).not.toContain('첫 요청');
}, 30000);
it('단독 인자 입력은 shell 기호를 명령으로 해석하지 않는다', async () => {
  const w = await work('argument', { input: 'argument', args: [resolve('test/fixtures/external-cli.cjs'), 'argument', '{prompt}'] });
  await request(`work/${w.id}/message`, { text: 'literal $(echo hi) & | "한글"' });
  await expect.poll(async () => (await state(w.id)).state, { timeout: 5000 }).toBe('idle');
  expect(JSON.stringify((await state(w.id)).events)).toContain('$(echo hi) & |');
});
it.skipIf(process.platform !== 'win32')('OS 인자 길이 제한은 실패로 기록하여 업무가 실행 중에 갇히지 않는다', async () => {
  const w = await work('argument', { input: 'argument', args: [resolve('test/fixtures/external-cli.cjs'), 'argument', '{prompt}'] });
  await request(`work/${w.id}/message`, { text: 'x'.repeat(40000) });
  expect((await state(w.id)).state).toBe('failed');
  expect((await state(w.id)).errorCode).toBe('argument-limit');
});
it('미설치·종료 실패·인증·시간·출력 제한을 구분하고 비밀 stderr를 저장하지 않는다', async () => {
  for (const [mode, extra, code] of [
    ['echo', { executable: join(root, 'missing.exe') }, 'missing-executable'],
    ['fail', {}, 'authentication-failed'], ['slow', { timeoutMs: 100 }, 'timeout'], ['overflow', {}, 'output-limit'],
  ] as const) {
    const w = await work(mode, extra); await request(`work/${w.id}/message`, { text: '테스트' });
    // A configured CLI timeout (10s) can be followed by Windows tree cleanup (10s).
    // Keep checking the actual terminal state and diagnostic, rather than racing cleanup.
    await expect.poll(async () => (await state(w.id)).state, { timeout: 25000, message: `CLI failure mode: ${mode}` }).toBe('failed');
    const result = await state(w.id); expect(result.errorCode).toBe(code); expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET');
  }
}, 90000);
it('지원하지 않는 질문·승인·고유 재개와 잘못된 연결을 거부한다', async () => {
  const w = await work();
  for (const action of ['answer', 'approval', 'reconnect']) expect((await request(`work/${w.id}/${action}`, {})).status).toBe(400);
  const store = app.get(WorkStore), bad = store.get(w.id)!; bad.toolId = 'unknown'; store.save(bad);
  expect((await request(`work/${w.id}/message`, { text: '오류' })).status).toBe(409);
  bad.toolId = 'cli'; store.save(bad);
});
it('입력 256KiB를 자르지 않고 거부하며 검토 전 구현과 동시 실행을 막는다', async () => {
  const w = await work('slow'), store = app.get(WorkStore);
  expect((await request(`work/${w.id}/action`, { action: 'implement' })).status).toBe(409);
  await writeFile(join(root, 'openspec', 'changes', w.changeName, 'proposal.md'), '큰'.repeat(90000));
  expect((await request(`work/${w.id}/message`, { text: '초과' })).status).toBe(400);
  await writeFile(join(root, 'openspec', 'changes', w.changeName, 'proposal.md'), '# 정상');
  await request(`work/${w.id}/message`, { text: '지연' });
  expect((await request(`work/${w.id}/message`, { text: '중복' })).status).toBe(409);
  const current = store.get(w.id)!; current.phase = 'implementation'; current.reviewedVersion = null; store.save(current);
  expect((await request(`work/${w.id}/message`, { text: '우회 구현' })).status).toBe(409);
  await request(`work/${w.id}/interrupt`, {});
  await expect.poll(async () => (await state(w.id)).state, { timeout: 5000 }).toBe('interrupted');
});
it('중단 시 자식 프로세스도 종료하고 재시작은 복구 상태만 기록하며 자동 실행하지 않는다', async () => {
  const pidFile = join(root, 'child.pid');
  const w = await work('tree', { args: [resolve('test/fixtures/external-cli.cjs'), 'tree', pidFile] });
  await request(`work/${w.id}/message`, { text: '자식 실행' });
  await expect.poll(async () => { try { return Number(await readFile(pidFile, 'utf8')); } catch { return 0; } }).toBeGreaterThan(0);
  const pid = Number(await readFile(pidFile, 'utf8'));
  await request(`work/${w.id}/interrupt`, {});
  await expect.poll(async () => (await state(w.id)).state, { timeout: 5000 }).toBe('interrupted');
  expect(() => process.kill(pid, 0)).toThrow();
  const store = app.get(WorkStore), current = store.get(w.id)!; current.state = 'running'; store.save(current);
  const events = store.events(w.id); await app.close(); app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  expect((await state(w.id)).state).toBe('recovery-required'); expect(app.get(WorkStore).events(w.id)).toEqual(events);
});
