import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkStore } from '../src/work/store';
describe('Codex 프로세스와 동일 대화', () => {
  let app: INestApplication, base: string, work: any, log: string;
  const request = async (path: string, body?: any) => {
    const res = await fetch(`${base}/api/${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-work-')); log = join(root, 'rpc.log');
    await mkdir(join(root, 'openspec', 'changes', 'test'), { recursive: true });
    await writeFile(join(root, 'openspec', 'changes', 'test', '.openspec.yaml'), 'schema: spec-driven\n');
    process.env.CODEX_TEST_DOC = join(root, 'openspec', 'changes', 'test', 'proposal.md'); await writeFile(process.env.CODEX_TEST_DOC, '# 초안\n');
    process.env.CONFIG_PATH = join(root, 'config.json'); process.env.DATA_DIR = join(root, 'data');
    process.env.CODEX_BIN = process.execPath; process.env.CODEX_ARGS = JSON.stringify([resolve('test/fixtures/codex.cjs')]); process.env.CODEX_TEST_LOG = log;
    await writeFile(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: './openspec' }], port: 13002 }));
    app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    work = (await request('work', { sourceId: 'demo', changeName: 'test', requestKey: 'test' })).data;
  });
  afterAll(async () => { await app.close(); for (const key of ['CONFIG_PATH', 'DATA_DIR', 'CODEX_BIN', 'CODEX_ARGS', 'CODEX_TEST_LOG', 'CODEX_TEST_MODE', 'CODEX_TEST_DOC']) delete process.env[key]; });
  it('연속 메시지에서 대화를 하나만 생성한다', async () => {
    const first = await request(`work/${work.id}/message`, { text: '초안 작성' }); expect(first.status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
    expect((await request(`work/${work.id}/message`, { text: '다시 수정' })).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(x => x.method === 'thread/start')).toHaveLength(1);
    expect(calls.filter(x => x.method === 'turn/start').every(x => x.params.threadId === 'thread-1')).toBe(true);
    for (const call of calls.filter(x => ['thread/start', 'turn/start'].includes(x.method))) {
      expect(call.params).toMatchObject({ approvalsReviewer: 'auto_review', approvalPolicy: 'on-request' });
    }
  });
  it('질문 답변은 원래 요청으로 전달하고 재전송하지 않는다', async () => {
    expect((await request(`work/${work.id}/message`, { text: '질문 해줘' })).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('waiting-input');
    const question = (await request(`work/${work.id}`)).data.questions[0]; expect(question.kind).toBe('input');
    expect((await request(`work/${work.id}/answer`, { questionId: question.id, answers: { choice: { answers: ['이 방식'] } } })).status).toBe(200);
    expect((await request(`work/${work.id}/answer`, { questionId: question.id, answers: { choice: { answers: ['중복'] } } })).status).toBe(409);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.questions.find((q: any) => q.id === question.id).reflection).toBe('applied');
    expect((await request(`work/${work.id}`)).data.questions.find((q: any) => q.id === question.id).documents[0]).toMatchObject({ path: 'proposal.md', version: expect.any(String) });
  });
  it('재시작 뒤 기존 대화를 재개한다', async () => {
    await app.close(); app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    expect((await request(`work/${work.id}/message`, { text: '이어서 진행' })).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(x => x.method === 'thread/start')).toHaveLength(1);
    expect(calls.filter(x => x.method === 'thread/resume').length).toBeGreaterThan(0);
    for (const call of calls.filter(x => x.method === 'thread/resume')) {
      expect(call.params).toMatchObject({ approvalsReviewer: 'auto_review', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    }
  });
  it('미답변 상태로 재시작하면 질문을 보존하고 같은 대화에서 복구한다', async () => {
    await request(`work/${work.id}/message`, { text: '질문 해줘' });
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('waiting-input');
    await app.close(); app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const restored = (await request(`work/${work.id}`)).data;
    expect(restored.questions.some((q: any) => q.status === 'expired')).toBe(true);
    expect((await request(`work/${work.id}/message`, { text: '미답변 질문부터 다시 확인해 줘' })).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
  });
  it('실행 승인은 요구사항 답변과 분리한다', async () => {
    await request(`work/${work.id}/message`, { text: '승인 해줘' });
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('waiting-approval');
    const q = (await request(`work/${work.id}`)).data.questions.find((x: any) => x.status === 'pending');
    expect((await request(`work/${work.id}/answer`, { questionId: q.id, answers: {} })).status).toBe(400);
    expect((await request(`work/${work.id}/approval`, { questionId: q.id, decision: 'accept' })).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
  });
  it('실행 중 추가 지시는 같은 대화 대기열로 처리한다', async () => {
    await request(`work/${work.id}/message`, { text: '지연 응답' });
    expect((await request(`work/${work.id}/message`, { text: '추가 수정' })).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.events.some((x: any) => x.type === 'user-message' && x.data.text === '추가 수정')).toBe(true);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
  });
  it('모든 단계의 구조화 질문을 원래 동적 도구 요청에 답한다', async () => {
    await request(`work/${work.id}/message`, { text: '구조화 질문' });
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('waiting-input');
    const q = (await request(`work/${work.id}`)).data.questions.find((x: any) => x.status === 'pending');
    expect(q.params.questions[0].id).toBe('filename');
    expect((await request(`work/${work.id}/answer`, { questionId: q.id, answers: { filename: { answers: ['sum.cjs'] } } })).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.find(x => x.method === 'thread/start').params.dynamicTools[0].name).toBe('ask_user');
    expect((await request(`work/${work.id}`)).data.questions.find((x: any) => x.id === q.id).reflection).toBe('needs-review');
    expect(calls.find(x => x.method === 'thread/start').params.sandbox).toBe('workspace-write');
    expect(calls.findLast(x => x.id === 998 && !x.method).result).toMatchObject({ success: true, contentItems: [{ type: 'inputText', text: expect.stringContaining('sum.cjs') }] });
  });
  it('일반 메시지로도 구현 단계의 최신 계획 검토를 우회할 수 없다', async () => {
    const store = app.get(WorkStore), current = store.get(work.id)!; current.phase = 'implementation'; current.reviewedVersion = null; store.save(current);
    expect((await request(`work/${work.id}/message`, { text: '바뀐 계획대로 구현해 줘' })).status).toBe(409);
    current.phase = 'verification'; store.save(current); expect((await request(`work/${work.id}/message`, { text: '검증 중 수정해 줘' })).status).toBe(409);
    current.phase = 'planning'; store.save(current);
  });
  it('재시작으로 만료된 질문은 같은 대화에 답변을 복구할 수 있다', async () => {
    await request(`work/${work.id}/message`, { text: '질문 해줘' });
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('waiting-input');
    await app.close(); app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const detail = (await request(`work/${work.id}`)).data, q = detail.questions.filter((x: any) => x.status === 'expired').at(-1);
    expect((await request(`work/${work.id}/answer`, { questionId: q.id, recover: true, answers: { choice: { answers: ['복구한 결정'] } } })).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
    expect((await request(`work/${work.id}`)).data.questions.find((x: any) => x.id === q.id).status).toBe('answered');
  });
  it('질문 도구가 종료되어도 미답변 질문은 복구 대상으로 남긴다', async () => {
    await request(`work/${work.id}/message`, { text: '질문 도구 종료' });
    await expect.poll(async () => (await request(`work/${work.id}`)).data.questions.find((q: any) => q.params.callId === 'expired-call')?.status).toBe('expired');
  });
  it('중단 확인 전 추가 실행을 막고 같은 대화로 재개한다', async () => {
    await request(`work/${work.id}/message`, { text: '지연 응답' });
    await request(`work/${work.id}/interrupt`, {});
    expect((await request(`work/${work.id}/message`, { text: '중단 뒤 이어서' })).data.queued).toBe(true);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('interrupted');
    expect((await request(`work/${work.id}/message`, { text: '같은 대화 재개' })).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.events.some((event: any) => event.type === 'user-message' && event.data.text === '중단 뒤 이어서')).toBe(true);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
    expect((await request(`work/${work.id}`)).data.threadId).toBe('thread-1');
  });
  it('대화 복원 실패 시 원래 ID를 보존하고 같은 ID로 다시 시도한다', async () => {
    await app.close(); process.env.CODEX_TEST_MODE = 'resume-error'; app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    expect((await request(`work/${work.id}/message`, { text: '복구 요청' })).status).toBe(409);
    expect((await request(`work/${work.id}`)).data).toMatchObject({ threadId: 'thread-1', state: 'recovery-required' });
    await app.close(); delete process.env.CODEX_TEST_MODE; app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    expect((await request(`work/${work.id}/message`, { text: '재시도' })).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
  });
  it('답변 복구 중 재시작되어도 질문과 작성 답변을 다시 복구할 수 있다', async () => {
    const store = app.get(WorkStore), q = store.records(work.id, 'question').find((q: any) => q.kind === 'input');
    store.record(q.id, work.id, 'question', { ...q, status: 'recovering', answer: { choice: { answers: ['보존할 답변'] } } });
    await app.close(); app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const restored = (await request(`work/${work.id}`)).data.questions.find((x: any) => x.id === q.id); expect(restored.status).toBe('expired'); expect(restored.answer.choice.answers).toEqual(['보존할 답변']);
    expect((await request(`work/${work.id}/answer`, { questionId: q.id, recover: true, answers: restored.answer })).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
  });
  it('다른 앱의 대화 점유는 원인을 안내하고 메시지 실행 없이 같은 대화에 다시 연결한다', async () => {
    await app.close(); process.env.CODEX_TEST_MODE = 'writer-conflict'; app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const failed = await request(`work/${work.id}/message`, { text: '충돌 재현' });
    expect(failed.status).toBe(409); expect(failed.data.message).toContain('다른 Codex 앱');
    expect((await request(`work/${work.id}`)).data).toMatchObject({ threadId: 'thread-1', errorCode: 'thread-in-use', state: 'recovery-required' });
    expect((await request(`work/${work.id}/reconnect`, {})).status).toBe(409);
    await app.close(); delete process.env.CODEX_TEST_MODE; app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const callsBefore = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect((await request(`work/${work.id}/reconnect`, {})).status).toBe(200);
    const restored = (await request(`work/${work.id}`)).data;
    expect(restored).toMatchObject({ threadId: 'thread-1', state: 'idle' }); expect(restored.error).toBeUndefined(); expect(restored.errorCode).toBeUndefined();
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(x => x.method === 'thread/start')).toHaveLength(callsBefore.filter(x => x.method === 'thread/start').length);
    expect(calls.filter(x => x.method === 'turn/start')).toHaveLength(callsBefore.filter(x => x.method === 'turn/start').length);
  });
  it('대화 생성 결과를 잃으면 새 대화를 자동으로 중복 생성하지 않는다', async () => {
    const store = app.get(WorkStore), current = store.get(work.id)!; current.threadId = null; store.save(current);
    await app.close(); process.env.CODEX_TEST_MODE = 'lost-start'; app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const starts = () => readFile(log, 'utf8').then(text => text.split('\n').filter(line => line.includes('"method":"thread/start"')).length);
    const before = await starts(); expect((await request(`work/${work.id}/message`, { text: '시작' })).status).toBe(409);
    expect((await request(`work/${work.id}/message`, { text: '재시도' })).status).toBe(409); expect(await starts()).toBe(before + 1);
  });
});
