import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkStore, type Work } from '../src/work/store';
import { AiToolService } from '../src/ai-tools/ai-tool.service';
import { ReviewService } from '../src/review/review.service';
import { guidedReviewInstructions, reviewInstructions } from '../src/review/instructions';

let app: INestApplication, base: string, root: string, store: WorkStore, work: Work;
const start = async () => {
  const response = await fetch(`${base}/api/work/review-work/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'guided-review' }) });
  return { status: response.status, data: await response.json() };
};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'guided-review-'));
  await mkdir(join(root, 'openspec/changes/feature/specs/feature'), { recursive: true });
  process.env.CONFIG_PATH = join(root, 'config.json'); process.env.DATA_DIR = join(root, 'data');
  await writeFile(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: './openspec' }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl(); store = app.get(WorkStore);
});
beforeEach(async () => {
  for (const [path, content] of Object.entries({ 'proposal.md': '- [review:confirm] 알림 범위\n', 'design.md': '- [review:choice] 알림 방식\n', 'tasks.md': '- [ ] 구현\n', 'specs/feature/spec.md': '- [review:assumption] 로컬 환경\n' })) {
    await writeFile(join(root, 'openspec/changes/feature', path), content);
  }
  store.db.exec('DELETE FROM records; DELETE FROM events; DELETE FROM work;');
  work = { id: 'review-work', sourceId: 'demo', changeName: 'feature', projectPath: root, requestKey: 'review-work', ideaIds: [], phase: 'reviewed', state: 'idle', threadId: 'existing-thread', reviewedVersion: 'existing-review', createdAt: '2026-10-25', updatedAt: '2026-10-25' };
  store.save(work);
  vi.spyOn(app.get(AiToolService), 'send').mockImplementation(async (id, _text, phase) => {
    const latest = store.get(id)!; latest.phase = phase!; latest.state = 'running'; store.save(latest); return latest;
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await app.close(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; });

it('답변이 문서에 반영된 항목만 검토 표시를 제거하도록 지시한다', () => {
  for (const prompt of [reviewInstructions, guidedReviewInstructions([])]) {
    expect(prompt).toContain('해결된 항목의 [review:…] 표기를 제거');
    expect(prompt).toContain('미해결 항목의 표기는 유지');
  }
});

it('검토 결과를 일반 목록으로 반영하면 해결된 항목만 목록에서 빠진다', async () => {
  await writeFile(join(root, 'openspec/changes/feature/proposal.md'), '- 알림 범위: 회원에게만 제공한다.\n');
  const result = await fetch(`${base}/api/work/${work.id}/review-items`);
  expect(result.status).toBe(200);
  const data = await result.json();
  expect(data.items.map((item: any) => item.path)).toEqual(['design.md', 'specs/feature/spec.md']);
});

it('최신 전체 문서의 검토 항목을 순서대로 같은 대화의 계획 단계에 전달한다', async () => {
  await writeFile(join(root, 'openspec/changes/feature/design.md'), '- [review:choice] 최신 알림 방식\n');
  const result = await start();
  expect(result.status).toBe(200);
  expect(result.data).toMatchObject({ threadId: 'existing-thread', phase: 'planning', state: 'running', reviewedVersion: 'existing-review' });
  const send = vi.mocked(app.get(AiToolService).send);
  expect(send).toHaveBeenCalledTimes(1);
  const [id, prompt, phase] = send.mock.calls[0];
  expect(id).toBe(work.id); expect(phase).toBe('planning');
  expect(prompt).toContain('한 번에 하나');
  expect(prompt).toContain('ask_user');
  expect(prompt).toContain('제품 코드는');
  const items = JSON.parse(prompt.split('검토 자료(JSON):\n')[1]);
  expect(items.map((item: any) => item.path)).toEqual(['proposal.md', 'design.md', 'specs/feature/spec.md']);
  expect(items[1]).toMatchObject({ text: '최신 알림 방식', startLine: 1 });
  expect(items[1].version).toMatch(/^[a-f0-9]{64}$/);
});

it.each(['running', 'connecting', 'creating-thread', 'waiting-input', 'waiting-approval', 'recovery-required'])('%s 상태에서 새 검토를 시작하지 않는다', async state => {
  store.save({ ...work, state }); expect((await start()).status).toBe(409); expect(app.get(AiToolService).send).not.toHaveBeenCalled();
});
it.each(['completed', 'archived'])('%s 업무는 검토를 시작하지 않는다', async phase => {
  store.save({ ...work, phase }); expect((await start()).status).toBe(409); expect(app.get(AiToolService).send).not.toHaveBeenCalled();
});
it('긴 검토 내용은 메시지 상한을 넘기지 않고 원문 조회를 지시한다', async () => {
  await writeFile(join(root, 'openspec/changes/feature/design.md'), `- [review:choice] ${'긴 검토 내용 '.repeat(15000)}\n`);
  expect((await start()).status).toBe(200);
  const prompt = vi.mocked(app.get(AiToolService).send).mock.calls[0][1];
  expect(prompt.length).toBeLessThan(100000);
  expect(JSON.parse(prompt.split('검토 자료(JSON):\n')[1])).toMatchObject({ itemCount: 3, readCurrentDocuments: true });
  expect(prompt).toContain('proposal.md');
});

it('미해결 질문이 남아 있으면 먼저 답변하도록 한다', async () => {
  store.record('q1', work.id, 'question', { kind: 'input', status: 'expired' });
  expect((await start()).status).toBe(409); expect(app.get(AiToolService).send).not.toHaveBeenCalled();
});
it('구조화 질문을 지원하지 않는 도구를 거부한다', async () => {
  store.save({ ...work, toolId: 'external', toolConfigSnapshot: { id: 'external', name: '외부', kind: 'external-cli' } });
  expect((await start()).status).toBe(409); expect(app.get(AiToolService).send).not.toHaveBeenCalled();
});
it('검토 항목이 없으면 AI를 실행하지 않는다', async () => {
  for (const path of ['proposal.md', 'design.md', 'specs/feature/spec.md']) await writeFile(join(root, 'openspec/changes/feature', path), '# 문서\n');
  expect((await start()).data.message).toContain('검토 항목이 없습니다'); expect(app.get(AiToolService).send).not.toHaveBeenCalled();
});
it('일부 문서를 읽지 못해도 부분 목록으로 검토를 시작하지 않는다', async () => {
  await unlink(join(root, 'openspec/changes/feature/design.md'));
  expect((await start()).status).toBe(409); expect(app.get(AiToolService).send).not.toHaveBeenCalled();
});
it('조회 중 다른 작업이 시작되면 새 검토를 시작하지 않는다', async () => {
  const review = app.get(ReviewService), read = review.read.bind(review);
  vi.spyOn(review, 'read').mockImplementation(async path => { const result = await read(path); store.save({ ...work, state: 'waiting-input' }); return result; });
  expect((await start()).status).toBe(409); expect(app.get(AiToolService).send).not.toHaveBeenCalled();
});
it('동시에 누른 검토 시작은 한 번만 AI에 전달한다', async () => {
  const results = await Promise.all([start(), start()]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]); expect(app.get(AiToolService).send).toHaveBeenCalledTimes(1);
});
