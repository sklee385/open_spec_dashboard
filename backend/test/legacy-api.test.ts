import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { LegacyService } from '../src/legacy/legacy.service';
import { firstValueFrom, filter, timeout } from 'rxjs';

describe('기존 UI API 계약', () => {
  let app: INestApplication, base: string, root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'openspec-api-'));
    const specRoot = join(root, 'openspec');
    await mkdir(join(specRoot, 'changes', 'empty'), { recursive: true });
    await writeFile(join(specRoot, 'changes', 'empty', '.openspec.yaml'), 'schema: spec-driven\n');
    await mkdir(join(specRoot, 'changes', 'planned', 'specs', 'nested', 'feature'), { recursive: true });
    await writeFile(join(specRoot, 'changes', 'planned', 'proposal.md'), '# 계획\n');
    await writeFile(join(specRoot, 'changes', 'planned', 'tasks.md'), '- [ ] 첫 작업\n- [x] 완료 작업\n');
    await writeFile(join(specRoot, 'changes', 'planned', 'specs', 'nested', 'feature', 'spec.md'), '# 명세\n');
    await mkdir(join(specRoot, 'specs', 'feature'), { recursive: true });
    await writeFile(join(specRoot, 'specs', 'feature', 'spec.md'), '# 기준 명세\n');
    process.env.CONFIG_PATH = join(root, 'config.json');
    process.env.DATA_DIR = join(root, 'data');
    await writeFile(process.env.CONFIG_PATH, JSON.stringify({ port: 13002, sources: [{ name: 'demo', path: './openspec' }] }));
    app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; });
  const get = async (path: string) => (await fetch(`${base}/api/${path}`)).json();
  it('상태 확인과 프로젝트 목록', async () => {
    expect(await (await fetch(`${base}/api/health`)).text()).toBe('ok');
    expect(await get('sources')).toMatchObject({ sources: [{ id: 'demo', name: 'demo', valid: true }] });
  });
  it('아이디어 한글 CRUD와 frontmatter 보존', async () => {
    const response = await fetch(`${base}/api/ideas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '문답 아이디어', description: 'AI와 수정', sourceId: 'demo' }) });
    expect(response.status).toBe(200);
    const idea = await response.json(); expect(idea).toMatchObject({ sourceId: 'demo', title: '문답 아이디어', projectId: null });
    const update = await fetch(`${base}/api/ideas/${encodeURIComponent(idea.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '수정', description: '답변 반영' }) });
    expect(await update.json()).toMatchObject({ createdAt: idea.createdAt, title: '수정' });
    expect(await readFile(join(root, 'openspec', 'ideas', `${idea.id.split('/')[1]}.md`), 'utf8')).toContain('createdAt:');
    expect((await get('ideas')).ideas).toHaveLength(1);
    expect((await fetch(`${base}/api/ideas/${encodeURIComponent(idea.id)}`, { method: 'DELETE' })).status).toBe(200);
    expect((await get('ideas')).ideas).toHaveLength(0);
  });
  it('빈 변경과 작업 통계·의존성 상태', async () => {
    const { changes } = await get('changes');
    expect(changes.find((c: any) => c.name === 'empty')).toMatchObject({ status: 'draft', schema: 'spec-driven', hasProposal: false });
    expect(changes.find((c: any) => c.name === 'planned')).toMatchObject({ status: 'in_progress', taskStats: { total: 2, done: 1 } });
    const detail = await get(`changes/${encodeURIComponent('demo/planned')}`);
    expect(detail.specs[0]).toEqual({ path: 'nested/feature/spec.md', content: '# 명세\n' });
  });
  it('중첩된 기준 명세 목록과 내용', async () => {
    expect(await get('specs')).toMatchObject({ specs: [{ id: 'demo/feature', path: 'feature/spec.md' }] });
    expect(await get(`specs/${encodeURIComponent('demo/feature')}`)).toMatchObject({ content: '# 기준 명세\n' });
  });
  it('출처 아이디어와 일부 문서만 남은 초안도 제목과 함께 조회한다', async () => {
    const change = join(root, 'openspec', 'changes', 'idea-123'); await mkdir(join(change, 'source-ideas'), { recursive: true });
    await writeFile(join(change, 'source-ideas', 'original.md'), '---\nid: original\ncreatedAt: 2026-10-25T00:00:00Z\nupdatedAt: 2026-10-25T00:00:00Z\n---\n\n# 다국어처리\n\n브라우저 언어 적용\n');
    const changes = (await get('changes')).changes; expect(changes.find((c: any) => c.name === 'idea-123')).toMatchObject({ title: '다국어처리', status: 'draft', hasProposal: false, hasTasks: false });
    const detail = await get(`changes/${encodeURIComponent('demo/idea-123')}`); expect(detail.title).toBe('다국어처리');
    const partial = join(root, 'openspec', 'changes', 'partial-docs'); await mkdir(partial); await writeFile(join(partial, 'tasks.md'), '- [ ] 구현\n');
    expect((await get('changes')).changes.find((c: any) => c.name === 'partial-docs')).toMatchObject({ status: 'todo', hasTasks: true });
  });
  it('잘못된 경로와 알 수 없는 프로젝트 거부', async () => {
    expect((await fetch(`${base}/api/ideas/${encodeURIComponent('demo/../../escape')}`, { method: 'DELETE' })).status).toBe(400);
    expect((await fetch(`${base}/api/ideas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x', description: '', sourceId: 'missing' }) })).status).toBe(400);
  });
  it('설정 변경 시 포트 보존·유효하지 않은 경로 제외', async () => {
    const response = await fetch(`${base}/api/config/sources`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: [{ name: 'demo', path: './openspec' }, { name: 'invalid', path: './missing' }] }) });
    expect(await response.json()).toMatchObject({ port: 13002, sources: [{ name: 'demo', path: './openspec' }] });
    expect(JSON.parse(await readFile(process.env.CONFIG_PATH!, 'utf8')).sources).toHaveLength(1);
  });
  it('실제 파일 변경을 보드 SSE 갱신으로 전달한다', async () => {
    const update = firstValueFrom(app.get(LegacyService).events().pipe(filter(event => event.type === 'update'), timeout(3000)));
    await writeFile(join(root, 'openspec', 'changes', 'planned', 'design.md'), '# 감시 대상 변경\n');
    expect(await update).toMatchObject({ type: 'update' });
  });
  it('연속 갱신을 중복 정리하고 해제한 SSE에는 더 전달하지 않는다', async () => {
    vi.useFakeTimers();
    try {
      const legacy = app.get(LegacyService), messages: any[] = [], subscription = legacy.events().subscribe(event => messages.push(event));
      legacy.updates.next(); legacy.updates.next(); legacy.updates.next(); await vi.advanceTimersByTimeAsync(150);
      expect(messages).toHaveLength(1); subscription.unsubscribe(); await vi.advanceTimersByTimeAsync(16000); expect(messages).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});
