import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/app';
import type { INestApplication } from '@nestjs/common';
import { WorkStore } from '../src/work/store';

let app: INestApplication, base: string, root: string;
async function request(body?: unknown) {
  const res = await fetch(`${base}/api/ai-tools`, { method: body ? 'PUT' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
const cli = { id: 'local', name: '로컬 CLI', kind: 'external-cli', executable: process.execPath, args: ['-e', 'console.log("ok")'], input: 'stdin', timeoutMs: 600000 };
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-tools-')); await mkdir(join(root, 'openspec'));
  process.env.CONFIG_PATH = join(root, 'config.json'); process.env.DATA_DIR = join(root, 'data');
  await writeFile(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: './openspec' }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
});
afterAll(async () => { await app.close(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; });
it('설정이 없으면 Codex를 제공하고 저장은 버전 충돌로부터 이전 파일을 보존한다', async () => {
  const initial = await request(); expect(initial.status).toBe(200); expect(initial.data.defaultToolId).toBe('codex');
  const body = { ...initial.data, tools: [...initial.data.tools, cli], defaultToolId: 'local' };
  const saved = await request(body); expect(saved.status).toBe(200); expect(saved.data.version).not.toBe(initial.data.version);
  expect((await request(body)).status).toBe(409);
  expect((await request()).data.defaultToolId).toBe('local');
});
it('중복 ID, 잘못된 인자, 내장 도구 삭제, 잘못된 기본값을 거부한다', async () => {
  const { data } = await request();
  for (const invalid of [
    { ...data, tools: [...data.tools, cli] },
    { ...data, tools: [data.tools[0], { ...cli, args: '문자열' }] },
    { ...data, tools: [data.tools[0], { ...cli, input: 'argument', args: ['prefix{prompt}'] }] },
    { ...data, tools: [cli] }, { ...data, defaultToolId: 'unknown' },
  ]) expect((await request(invalid)).status).toBe(400);
  expect((await request()).data.version).toBe(data.version);
});
it('손상 설정 파일을 기본값으로 덮어쓰지 않는다', async () => {
  const path = join(root, 'ai-tools.json'); const saved = await readFile(path, 'utf8');
  await writeFile(path, '{broken'); expect((await request()).status).toBe(409);
  expect((await request({ version: '0', defaultToolId: 'codex', tools: [] })).status).toBe(409);
  expect(await readFile(path, 'utf8')).toBe('{broken'); await writeFile(path, saved);
});
it('새 업무만 기본 도구를 고정하고 참조 도구 삭제를 거부하며 기존 데이터는 보존한다', async () => {
  for (const name of ['first', 'second']) {
    await mkdir(join(root, 'openspec', 'changes', name), { recursive: true });
    await writeFile(join(root, 'openspec', 'changes', name, 'proposal.md'), '# 계획');
  }
  const create = async (name: string) => (await fetch(`${base}/api/work`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: 'demo', changeName: name, requestKey: name }) })).json();
  const first = await create('first'); expect(first.toolId).toBe('local'); expect(first.toolConfigSnapshot.executable).toBe(process.execPath);
  const store = app.get(WorkStore); first.threadId = 'legacy-thread'; first.reviewedVersion = 'review'; store.save(first); store.event(first.id, 'user-message', { text: '기존 대화' });
  const before = store.get(first.id), events = store.events(first.id);
  const { data } = await request(); await request({ ...data, defaultToolId: 'codex', tools: data.tools.map((t: any) => t.id === 'local' ? { ...t, name: '수정 도구' } : t) });
  expect(store.get(first.id)).toEqual(before); expect(store.events(first.id)).toEqual(events);
  expect((await create('second')).toolId).toBe('codex');
  const current = (await request()).data;
  const rejected = await request({ ...current, tools: current.tools.filter((t: any) => t.id !== 'local') });
  expect(rejected.status).toBe(409); expect(rejected.data.work[0].id).toBe(first.id);
  const legacy = store.get(first.id)!; delete legacy.toolId; delete legacy.toolConfigSnapshot; delete legacy.toolCapabilities; store.save(legacy);
  const raw = store.get(first.id);
  const result = await (await fetch(`${base}/api/work/${first.id}`)).json();
  expect(result.toolId).toBe('codex'); expect(result.providerSessionId).toBe('legacy-thread'); expect(store.get(first.id)).toEqual(raw);
});
