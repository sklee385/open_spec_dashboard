import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserController } from '../src/browser/browser.controller';
import { BrowserService } from '../src/browser/browser.service';
import { WorkStore } from '../src/work/store';
let app: INestApplication, store: WorkStore, base: string;
const saved = process.env.DATA_DIR, id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222', contextId = 'a'.repeat(64);
const browser = { run: vi.fn(), cancel: vi.fn(), activity: vi.fn(), status: vi.fn(), reconcile: vi.fn(), store: undefined as unknown as WorkStore };
@Module({ controllers: [BrowserController], providers: [{ provide: BrowserService, useValue: browser }] }) class Fixture {}
beforeAll(async () => {
  process.env.DATA_DIR = join(mkdtempSync(join(tmpdir(), 'bhttp-')), 'data'); store = browser.store = new WorkStore();
  for (const workId of ['a', 'b']) store.save({ id: workId, sourceId: 'fixture', projectPath: process.env.DATA_DIR, changeName: workId, requestKey: workId, ideaIds: [], phase: 'verification', state: 'idle', threadId: workId, reviewedVersion: null, createdAt: '', updatedAt: '' });
  app = await NestFactory.create(Fixture, { logger: false }); app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1'); base = `${await app.getUrl()}/api/work`;
});
afterAll(async () => { await app?.close(); store?.onApplicationShutdown(); if (saved === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = saved; });
beforeEach(() => {
  vi.clearAllMocks(); browser.run.mockReturnValue({ id, status: 'running' }); browser.cancel.mockResolvedValue({ requested: true }); browser.reconcile.mockResolvedValue({ id, status: 'interrupted', cleanupStatus: 'confirmed', reconciliation: 'terminated', processTerminated: true }); browser.status.mockResolvedValue({ results: [], running: false, busy: false });
  browser.activity.mockReturnValue({ running: true, busy: true, live: { id, candidateId: 'c' } });
  store.record(id, 'a', 'browser-verification', { candidateId: 'c', executionBinding: { contextId }, status: 'running' });
});
const post = (path: string, body?: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
it('후보 HTTP 실행은 route의 업무·후보와 user 소유만 사용하며 경로·명령 입력을 거부한다', async () => {
  expect((await post('/a/integration/c/browser/run', {})).status).toBe(200); expect(browser.run).toHaveBeenCalledWith('a', 'user', 'c');
  expect((await post('/a/integration/c/browser/run', { path: 'other', candidateId: 'b' })).status).toBe(400); expect(browser.run).toHaveBeenCalledTimes(1);
});
it('후보 중단은 정확한 runId·대상·호스트 context만 사용하고 이전 실행·다른 후보·Work 중단과 섞지 않는다', async () => {
  expect(await (await post('/a/integration/c/browser/cancel', { runId: id })).json()).toEqual({ requested: true }); expect(browser.cancel).toHaveBeenCalledWith('a', { contextId, runId: id, candidateId: 'c' }); browser.cancel.mockClear();
  for (const [path, body] of [['/a/integration/c/browser/cancel', { runId: other }], ['/a/integration/other/browser/cancel', { runId: id }], ['/a/browser/cancel', undefined]] as const) expect(await (await post(path, body)).json()).toEqual({ requested: false });
  expect(browser.cancel).not.toHaveBeenCalled();
});
it('누락·추가 중단 입력과 다른 업무의 run을 거부하고 프로세스 소유를 추정하지 않는다', async () => {
  expect((await post('/a/integration/c/browser/cancel')).status).toBe(400); expect((await post('/a/integration/c/browser/cancel', { runId: id, force: true })).status).toBe(400);
  store.record(other, 'b', 'browser-verification', { candidateId: 'c', executionBinding: { contextId }, status: 'running' }); browser.activity.mockReturnValue({ running: true, busy: true, live: { id: other, candidateId: 'c' } });
  expect((await post('/a/integration/c/browser/cancel', { runId: other })).status).toBe(409); expect(browser.cancel).not.toHaveBeenCalled();
});
it('후보의 명시 inspect와 업무의 cheap 조회를 분리하고 임의 query를 거부한다', async () => {
  expect((await fetch(base + '/a/integration/c/browser?inspect=1')).status).toBe(200); expect(browser.status).toHaveBeenCalledWith('a', true, 'c');
  expect((await fetch(base + '/a/browser')).status).toBe(200); expect(browser.status).toHaveBeenCalledWith('a', false);
  expect((await fetch(base + '/a/integration/c/browser?target=other')).status).toBe(400);
});
it('같은 HTTP 요청 키의 응답 유실·재요청은 기존 실행만 반환하고 다른 후보로 키를 재사용하지 않는다', async () => {
  browser.run.mockImplementation((workId:string,owner:string,candidateId:string,_binding:unknown,requestKey:string)=>{store.record(id,workId,'browser-verification',{owner,candidateId,requestKey,status:'running',executionBinding:{contextId}});return {id,status:'running'};});
  const key='33333333-3333-4333-8333-333333333333';
  const first=await post('/a/integration/c/browser/run',{requestKey:key});expect(first.status).toBe(200);expect(await first.json()).toMatchObject({id,requestKey:key,status:'accepted',runStatus:'running'});
  expect(await(await post('/a/integration/c/browser/run',{requestKey:key})).json()).toMatchObject({id,requestKey:key,status:'accepted'});expect(browser.run).toHaveBeenCalledTimes(1);
  expect((await post('/a/integration/other/browser/run',{requestKey:key})).status).toBe(409);expect(browser.run).toHaveBeenCalledTimes(1);
});
it('종료 재확인 HTTP는 명시한 같은 업무·후보 실행만 복구하고 임의 강제 해제를 받지 않는다', async () => {
  expect((await post('/a/integration/c/browser/reconcile',{runId:id,confirmed:true})).status).toBe(200);expect(browser.reconcile).toHaveBeenCalledWith('a',id,true);browser.reconcile.mockClear();
  expect((await post('/a/integration/other/browser/reconcile',{runId:id,confirmed:true})).status).toBe(409);
  expect((await post('/a/integration/c/browser/reconcile',{runId:id,confirmed:false})).status).toBe(400);expect((await post('/a/integration/c/browser/reconcile',{runId:id,confirmed:true,force:true})).status).toBe(400);expect(browser.reconcile).not.toHaveBeenCalled();
});