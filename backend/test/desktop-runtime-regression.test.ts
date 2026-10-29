import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkStore } from '../src/work/store';
import { CodexService } from '../src/codex/codex.service';
import { DesktopLifecycle } from '../src/desktop/lifecycle';
let app: INestApplication;
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); for (const key of ['DATA_DIR', 'CONFIG_PATH', 'CODEX_BIN', 'CODEX_ARGS', 'CODEX_TEST_MODE']) delete process.env[key]; });
async function setup(mode?: string) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-runtime-')); mkdirSync(join(root, 'openspec', 'changes', 'test'), { recursive: true });
  process.env.DATA_DIR = join(root, 'data'); process.env.CONFIG_PATH = join(root, 'config.json');
  process.env.CODEX_BIN = process.execPath; process.env.CODEX_ARGS = JSON.stringify([resolve('test/fixtures/codex.cjs')]);
  if (mode) process.env.CODEX_TEST_MODE = mode;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(root, 'openspec') }] }));
  app = await createApplication(); await app.init();
  const store = app.get(WorkStore), codex = app.get(CodexService), lifecycle = app.get(DesktopLifecycle);
  store.save({ id: 'w', sourceId: 'demo', projectPath: root, changeName: 'test', requestKey: 'w', ideaIds: [], phase: 'planning', state: 'idle', threadId: null, reviewedVersion: null, createdAt: '', updatedAt: '' });
  return { store, codex, lifecycle, diagnostic: () => lifecycle.diagnostics().works[0] };
}
it('명시적 턴 시작 거절은 실행 없음으로 판정하고 복구와 정상 종료를 허용한다', async () => {
  const f = await setup('turn-rejected');
  await expect(f.codex.send('w', '요청')).rejects.toThrow();
  expect(f.diagnostic()).toMatchObject({ state: 'recovery-required', runtime: 'inactive', canRecover: true });
  expect(f.lifecycle.status().idle).toBe(true);
});
it('결과 불명 실패는 active 대신 unknown이며 명시적 재연결은 새 턴 없이 복구한다', async () => {
  const f = await setup(); const original = f.codex.client.rpc.bind(f.codex.client);
  const rpc = vi.spyOn(f.codex.client, 'rpc').mockImplementation((method, params) => method === 'turn/start' ? Promise.reject(new Error('응답 결과 불명')) : original(method, params));
  await expect(f.codex.send('w', '요청')).rejects.toThrow();
  expect(f.diagnostic()).toMatchObject({ runtime: 'unknown', canRecover: false });
  rpc.mockRestore();
  const reconnectCalls = vi.spyOn(f.codex.client, 'rpc');
  f.lifecycle.setSafeMode({ enabled: true });
  await f.codex.reconnect('w');
  expect(reconnectCalls.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
  expect(f.diagnostic()).toMatchObject({ runtime: 'unknown', state: 'recovery-required', canRecover: false });
  expect(f.lifecycle.status().idle).toBe(false);
});
it('실행 중 응답 유실 후 재연결만으로 종료를 허용하지 않고 완료 증거를 기다린다', async () => {
  const f = await setup('turn-hold'); const original = f.codex.client.rpc.bind(f.codex.client);
  const rpc = vi.spyOn(f.codex.client, 'rpc').mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (method === 'turn/start') throw new Error('성공 응답 유실');
    return result;
  });
  await expect(f.codex.send('w', '요청')).rejects.toThrow(); rpc.mockRestore();
  await f.codex.reconnect('w');
  expect(f.diagnostic()).toMatchObject({ runtime: 'unknown', canRecover: false, canInterrupt: true });
  expect(f.lifecycle.status().idle).toBe(false);
  await expect(f.codex.send('w', '중복 실행')).rejects.toThrow('재연결');
  await f.codex.interrupt('w');
  expect(f.diagnostic().runtime).toBe('unknown');
  await expect.poll(() => f.diagnostic().runtime).toBe('inactive');
});
it('연결 해제 생존 턴은 재연결 후에도 불명이며 수동 중단 완료 확인 뒤에만 종료한다', async () => {
  const f = await setup('turn-hold'); await f.codex.send('w', '요청');
  f.codex.client.emit('disconnected', '부모 연결 종료');
  await f.codex.reconnect('w');
  expect(f.diagnostic()).toMatchObject({ runtime: 'unknown', canInterrupt: true });
  await f.codex.interrupt('w');
  expect(f.diagnostic().runtime).toBe('unknown');
  await expect.poll(() => f.diagnostic().runtime).toBe('inactive');
});
it('서버 재시작으로 등록부가 사라져도 불명 실행은 새 메시지로 재실행하지 않는다', async () => {
  const f = await setup('turn-hold'); await f.codex.send('w', '실행');
  f.store.save({ ...f.store.get('w')!, state: 'recovery-required' });
  await app.close(); app = await createApplication(); await app.init();
  const codex = app.get(CodexService), rpc = vi.spyOn(codex.client, 'rpc');
  await expect(codex.send('w', '중복 실행')).rejects.toThrow('재연결');
  expect(rpc.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
});
it('현재 턴 ID를 모르는 재연결은 과거 또는 미확인 턴 완료로 종료 판정을 풀지 않는다', async () => {
  const f = await setup('turn-hold'); await f.codex.send('w', '첫 요청');
  f.codex.client.emit('notification', { method: 'turn/completed', generation: f.codex.client.generation, params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  const original = f.codex.client.rpc.bind(f.codex.client);
  vi.spyOn(f.codex.client, 'rpc').mockImplementation((method, params) => {
    if (method === 'turn/start') return Promise.reject(new Error('새 실행 응답 유실'));
    if (method === 'thread/read') return Promise.reject(new Error('현재 턴 조회 실패'));
    return original(method, params);
  });
  await expect(f.codex.send('w', '새 요청')).rejects.toThrow();
  await f.codex.reconnect('w');
  for (const id of ['turn-1', 'unverified-new-turn']) {
    f.codex.client.emit('notification', { method: 'turn/completed', generation: f.codex.client.generation, params: { threadId: 'thread-1', turn: { id, status: 'completed' } } });
    expect(f.diagnostic()).toMatchObject({ runtime: 'unknown', state: 'recovery-required', canRecover: false });
    expect(f.lifecycle.status().idle).toBe(false);
  }
});
it('과거 턴이 완료되었어도 같은 대화에 다른 진행 턴이 있으면 종료하지 않는다', async () => {
  const f = await setup('turn-hold'); await f.codex.send('w', '요청');
  f.codex.client.emit('disconnected', '연결 종료');
  const original = f.codex.client.rpc.bind(f.codex.client);
  vi.spyOn(f.codex.client, 'rpc').mockImplementation((method, params) => method === 'thread/read' ? Promise.resolve({ thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed' }, { id: 'actual-running-turn', status: 'inProgress' }] } }) : original(method, params));
  await f.codex.reconnect('w');
  expect(f.diagnostic().runtime).toBe('unknown');
  expect(f.lifecycle.status().idle).toBe(false);
});
it('이전 턴의 늦은 완료 알림은 새 턴의 실행 소유권을 지우지 않는다', async () => {
  const f = await setup('turn-hold'); await f.codex.send('w', '첫 요청');
  f.codex.client.emit('notification', { method: 'turn/completed', generation: f.codex.client.generation, params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  const original = f.codex.client.rpc.bind(f.codex.client);
  vi.spyOn(f.codex.client, 'rpc').mockImplementation((method, params) => method === 'turn/start' ? Promise.resolve({ turn: { id: 'new-turn' } }) : original(method, params));
  await f.codex.send('w', '새 요청');
  f.codex.client.emit('notification', { method: 'turn/completed', generation: f.codex.client.generation, params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  expect(f.diagnostic()).toMatchObject({ runtime: 'active', state: 'running' });
});
it('연결 해제된 불명 실행은 새 턴 대신 명시적 재연결을 요구한다', async () => {
  const f = await setup('turn-hold'); await f.codex.send('w', '요청');
  f.codex.client.emit('disconnected', '종료');
  const rpc = vi.spyOn(f.codex.client, 'rpc');
  await expect(f.codex.send('w', '다시 실행')).rejects.toThrow('재연결');
  expect(rpc.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);
});
it('부모 연결 해제로 자식 종료를 단정하지 않고 이전 세대 완료 알림도 무시한다', async () => {
  const f = await setup(); await f.codex.send('w', '지연 질문 해줘');
  f.codex.client.emit('disconnected', '연결 종료');
  expect(f.diagnostic()).toMatchObject({ runtime: 'unknown', canRecover: false });
  f.codex.client.emit('notification', { method: 'turn/completed', generation: 'old-generation', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  expect(f.diagnostic().runtime).toBe('unknown');
});
it('완료 업무의 과거 running 기록은 보존하면서 종료를 허용한다', async () => {
  const f = await setup();
  f.store.save({ ...f.store.get('w')!, phase: 'completed', state: 'running' });
  f.store.record('v', 'w', 'verification', { status: 'running' });
  f.store.record('b', 'w', 'browser-verification', { status: 'running' });
  expect(f.lifecycle.status().idle).toBe(true);
  expect(f.diagnostic()).toMatchObject({ runtime: 'inactive', status: 'normal', canRecover: false });
  expect(f.store.get('w')?.state).toBe('running');
  expect(f.store.records('w', 'verification')[0].status).toBe('running');
});
it('실제로 실행 중인 업무는 완료 phase로 잘못 저장되어도 종료를 막는다', async () => {
  const f = await setup(); await f.codex.send('w', '지연 질문 해줘');
  f.store.save({ ...f.store.get('w')!, phase: 'completed' });
  expect(f.lifecycle.status().idle).toBe(false);
  expect(f.diagnostic().runtime).toBe('active');
});
