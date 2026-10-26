import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkStore } from '../src/work/store';
import { OpenSpecService } from '../src/openspec/openspec.service';
import { WorkService } from '../src/work/work.service';

describe('업무·문서 영속성과 실행 조건', () => {
  let app: INestApplication, base: string, root: string, work: any;
  const request = async (path: string, method = 'GET', body?: any) => {
    const res = await fetch(`${base}/api/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'openspec-work-'));
    await mkdir(join(root, 'openspec', 'changes', 'feature', 'specs', 'feature'), { recursive: true });
    for (const file of ['proposal.md', 'design.md', 'specs/feature/spec.md']) await writeFile(join(root, 'openspec', 'changes', 'feature', file), '# 초안\n');
    await writeFile(join(root, 'openspec', 'changes', 'feature', 'tasks.md'), '- [ ] 구현\n');
    process.env.CONFIG_PATH = join(root, 'config.json'); process.env.DATA_DIR = join(root, 'data');
    process.env.CODEX_BIN = process.execPath; process.env.CODEX_ARGS = JSON.stringify([resolve('test/fixtures/codex.cjs')]);
    await writeFile(process.env.CONFIG_PATH, JSON.stringify({ port: 13002, sources: [{ name: 'demo', path: './openspec' }] }));
    app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); for (const key of ['CONFIG_PATH', 'DATA_DIR', 'CODEX_BIN', 'CODEX_ARGS']) delete process.env[key]; });
  it('기존 변경을 업무로 연결하고 중복 생성하지 않는다', async () => {
    const result = await request('work', 'POST', { sourceId: 'demo', changeName: 'feature', requestKey: 'create-feature' });
    expect(result.status).toBe(200); work = result.data;
    expect(work).toMatchObject({ sourceId: 'demo', changeName: 'feature', phase: 'planning', threadId: null });
    expect((await request('work', 'POST', { sourceId: 'demo', changeName: 'feature', requestKey: 'create-feature' })).data.id).toBe(work.id);
  });
  it('문서를 읽고 버전을 확인하며 직접 저장한다', async () => {
    const doc = await request(`work/${work.id}/document?path=proposal.md`);
    expect(doc.status).toBe(200); expect(doc.data.content).toBe('# 초안\n');
    const saved = await request(`work/${work.id}/document`, 'PUT', { path: 'proposal.md', version: doc.data.version, content: '# 수정\n' });
    expect(saved.status).toBe(200); expect(saved.data.version).not.toBe(doc.data.version);
    expect(await readFile(join(root, 'openspec', 'changes', 'feature', 'proposal.md'), 'utf8')).toBe('# 수정\n');
    expect((await request(`work/${work.id}/document`, 'PUT', { path: 'proposal.md', version: doc.data.version, content: '충돌' })).status).toBe(409);
  });
  it('문서 경계 이탈을 거부한다', async () => {
    expect((await request(`work/${work.id}/document?path=${encodeURIComponent('../../config.yaml')}`)).status).toBe(400);
    expect((await request(`work/${work.id}/document`, 'PUT', { path: '../x', version: 'x', content: 'x' })).status).toBe(400);
  });
  it('검토 전 실행과 검증 전 완료를 막는다', async () => {
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'implement' })).status).toBe(409);
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'complete' })).status).toBe(409);
  });
  it('검토 후 문서 수정은 검토를 무효화한다', async () => {
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'review' })).status).toBe(200);
    const doc = (await request(`work/${work.id}/document?path=design.md`)).data;
    await request(`work/${work.id}/document`, 'PUT', { path: 'design.md', version: doc.version, content: '# 다시 수정\n' });
    expect((await request(`work/${work.id}`)).data.reviewedVersion).toBeNull();
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'implement' })).status).toBe(409);
  });
  it('사용자 질문과 명령을 외부 Origin에서 보낼 수 없다', async () => {
    const res = await fetch(`${base}/api/work`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: 'demo', changeName: 'feature', requestKey: 'foreign' }) });
    expect(res.status).toBe(403);
  });
  it('서버 재시작 후 업무와 저장 상태를 복원한다', async () => {
    await app.close(); app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    const restored = await request(`work/${work.id}`);
    expect(restored.status).toBe(200); expect(restored.data.changeName).toBe('feature');
    expect((await request('work')).data.work).toHaveLength(1);
  });
  it('작업 화면에서 실제 OpenSpec 진행 상태를 조회한다', async () => {
    const result = await request(`work/${work.id}/openspec?operation=status`);
    expect(result.status).toBe(200); expect(result.data.ok).toBe(true);
    expect(result.data.json.changeName).toBe('feature');
  });
  it('아이디어를 변경으로 전환하고 원본을 보존한다', async () => {
    const idea = (await request('ideas', 'POST', { sourceId: 'demo', title: '한 세션 업무', description: '문답으로 진행' })).data;
    const created = await request('work', 'POST', { sourceId: 'demo', changeName: 'idea-work', ideaId: idea.id, requestKey: 'promote-idea' });
    expect(created.status).toBe(200); expect(created.data.ideaIds).toEqual([idea.id]);
    expect((await request('ideas')).data.ideas.some((x: any) => x.id === idea.id)).toBe(false);
    expect(await readFile(join(root, 'openspec', 'changes', 'idea-work', 'source-ideas', `${idea.id.split('/')[1]}.md`), 'utf8')).toContain('문답으로 진행');
  });
  it('변경 생성 결과가 불명확해도 아이디어를 보존하고 재시도 때 하나로 연결한다', async () => {
    const idea = (await request('ideas', 'POST', { sourceId: 'demo', title: '불명확한 생성', description: '원본 보존' })).data;
    const service = app.get(OpenSpecService), original = service.run.bind(service);
    const spy = vi.spyOn(service, 'run').mockImplementation(async (cwd, args) => { const result = await original(cwd, args); return args[0] === 'new' ? { ...result, ok: false, code: -1, stderr: '결과 수신 실패' } : result; });
    const body = { sourceId: 'demo', changeName: 'retry-work', ideaId: idea.id, requestKey: 'retry-promotion' };
    expect((await request('work', 'POST', body)).status).toBe(409); spy.mockRestore();
    expect((await request('ideas')).data.ideas.some((x: any) => x.id === idea.id)).toBe(true);
    const [a, b] = await Promise.all([request('work', 'POST', body), request('work', 'POST', body)]);
    expect(a.status).toBe(200); expect(b.data.id).toBe(a.data.id);
  });
  it('업무 저장 뒤 원본 이동이 실패해도 재시도에서 아이디어 연결을 마친다', async () => {
    const idea = (await request('ideas', 'POST', { sourceId: 'demo', title: '부분 생성', description: '다시 연결' })).data;
    const change = join(root, 'openspec', 'changes', 'partial-work'); await mkdir(change);
    await writeFile(join(change, '.openspec.yaml'), 'schema: spec-driven\n'); await writeFile(join(change, 'source-ideas'), '이동 방해 테스트');
    const body = { sourceId: 'demo', changeName: 'partial-work', ideaId: idea.id, requestKey: 'partial-create' };
    expect((await request('work', 'POST', body)).status).toBe(500);
    await unlink(join(change, 'source-ideas')); expect((await request('work', 'POST', body)).status).toBe(200);
    expect(await readFile(join(change, 'source-ideas', `${idea.id.split('/')[1]}.md`), 'utf8')).toContain('다시 연결');
  });
  it('업무 이벤트는 커서 이후만 SSE로 재전송한다', async () => {
    const detail = (await request(`work/${work.id}`)).data;
    const cursor = detail.events[0].seq;
    const response = await fetch(`${base}/api/work/${work.id}/events?after=${cursor}`);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader(), chunk = await reader.read(); await reader.cancel();
    const ids = [...new TextDecoder().decode(chunk.value).matchAll(/^id: (\d+)/gm)].map(x => Number(x[1]));
    expect(ids.length).toBeGreaterThan(0); expect(ids.every(id => id > cursor)).toBe(true);
  });
  it('다른 업무 이벤트가 섞이지 않으며 저장된 프로젝트 경계를 지킨다', async () => {
    const store = app.get(WorkStore), other = store.list().find(w => w.id !== work.id)!, events: any[] = [];
    const cursor = store.events(work.id).at(-1)!.seq;
    const subscription = app.get(WorkService).events(work.id, cursor).subscribe(event => events.push(event));
    store.event(other.id, 'foreign-test', {}); store.event(work.id, 'local-test', {}); subscription.unsubscribe();
    expect(events.map(event => event.data.type)).toEqual(['local-test']);
    const current = store.get(work.id)!, original = current.projectPath; current.projectPath = other.projectPath + '-other'; store.save(current);
    expect((await request(`work/${work.id}`)).status).toBe(409); current.projectPath = original; store.save(current);
    expect((store.db.prepare('PRAGMA user_version').get() as any).user_version).toBe(1);
  });
  it('검토 후 구현하고 실제 검증·사용자 확인을 거쳐 완료한다', async () => {
    await request(`work/${work.id}/action`, 'POST', { action: 'review' });
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'implement' })).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
    await writeFile(join(root, 'openspec', 'changes', 'feature', 'tasks.md'), '- [x] 구현\n');
    expect((await request(`work/${work.id}/verification-plan`, 'PUT', { commands: [{ id: 'test', command: process.execPath, args: ['-e', 'process.exit(1)'] }] })).status).toBe(200);
    await request(`work/${work.id}/verify`, 'POST', { commandId: 'test' });
    await expect.poll(async () => (await request(`work/${work.id}`)).data.verifications.at(-1)?.status).toBe('failed');
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'complete', confirmed: true })).status).toBe(409);
    await request(`work/${work.id}/verification-plan`, 'PUT', { commands: [{ id: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'] }] });
    await request(`work/${work.id}/verify`, 'POST', { commandId: 'test' });
    await expect.poll(async () => (await request(`work/${work.id}`)).data.verifications.at(-1)?.status).toBe('passed');
    await writeFile(join(root, 'result.txt'), '검증 뒤 추가 변경');
    expect((await request(`work/${work.id}`)).data.verifications.at(-1).fresh).toBe(false);
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'complete', confirmed: true })).status).toBe(409);
    await unlink(join(root, 'result.txt'));
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'complete' })).status).toBe(409);
    const store = app.get(WorkStore), reviewed = store.get(work.id)!;
    store.record('required-question', work.id, 'question', { kind: 'input', status: 'pending', params: { questions: [] } });
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'complete', confirmed: true })).status).toBe(409);
    store.record('required-question', work.id, 'question', { kind: 'input', status: 'expired', params: { questions: [] } });
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'complete', confirmed: true })).status).toBe(409);
    store.record('required-question', work.id, 'question', { kind: 'input', status: 'answered', params: { questions: [] } });
    store.save({ ...reviewed, reviewedVersion: null }); expect((await request(`work/${work.id}/action`, 'POST', { action: 'complete', confirmed: true })).status).toBe(409); store.save(reviewed);
    await writeFile(join(root, 'openspec', 'changes', 'feature', 'tasks.md'), '- [ ] 구현\n');
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'complete', confirmed: true })).status).toBe(409);
    await writeFile(join(root, 'openspec', 'changes', 'feature', 'tasks.md'), '- [x] 구현\n');
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'complete', confirmed: true })).data.phase).toBe('completed');
  });
  it('완료된 문서는 다시 열기 전 수정할 수 없고 실행 중 강제 재개가 불가능하다', async () => {
    const doc = (await request(`work/${work.id}/document?path=design.md`)).data;
    expect((await request(`work/${work.id}/document`, 'PUT', { path: doc.path, version: doc.version, content: '덮어쓰기' })).status).toBe(409);
    const store = app.get(WorkStore), current = store.get(work.id)!; current.state = 'running'; store.save(current);
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'reopen' })).status).toBe(409);
    current.state = 'idle'; store.save(current);
  });
  it('구현 중 계획을 재검토하면 현재 구현 단계를 유지한다', async () => {
    const store = app.get(WorkStore), current = store.get(work.id)!; current.phase = 'implementation'; store.save(current);
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'review' })).data.phase).toBe('implementation');
    current.phase = 'completed'; store.save(current);
  });
  it('CLI 성공 응답만으로 보관 완료를 처리하지 않는다', async () => {
    const spy = vi.spyOn(app.get(OpenSpecService), 'run').mockResolvedValueOnce({ ok: true, code: 0, stdout: 'ok', stderr: '' });
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'archive' })).status).toBe(409);
    expect((await request(`work/${work.id}`)).data.phase).toBe('completed'); spy.mockRestore();
  });
  it('실제 보관 후 기준 명세와 보관 문서를 읽을 수 있다', async () => {
    const current = app.get(WorkStore).get(work.id)!; current.ideaIds = ['demo/archived-idea']; app.get(WorkStore).save(current);
    await mkdir(join(root, 'openspec', 'changes', 'feature', 'source-ideas')); await writeFile(join(root, 'openspec', 'changes', 'feature', 'source-ideas', 'archived-idea.md'), '# 원본 아이디어\n');
    await writeFile(join(root, 'openspec', 'changes', 'feature', 'specs', 'feature', 'spec.md'), '## ADDED Requirements\n\n### Requirement: Example feature\nThe system SHALL return a value.\n\n#### Scenario: Value returned\n- **WHEN** a value is requested\n- **THEN** a value is returned\n');
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'archive' })).status).toBe(200);
    const archived = await request(`work/${work.id}`); expect(archived.status).toBe(200); expect(archived.data.phase).toBe('archived');
    expect((await request(`work/${work.id}/document?path=design.md`)).status).toBe(200);
    expect(await readFile(join(root, 'openspec', 'specs', 'feature', 'spec.md'), 'utf8')).toContain('Example feature');
    const spec = await request(`work/${work.id}/openspec?operation=spec&artifact=feature`); expect(spec.data.ok).toBe(true); expect(spec.data.stdout).toContain('Example feature');
    const archiveName = app.get(WorkStore).get(work.id)!.archiveName;
    expect((await request('work', 'POST', { sourceId: 'demo', changeName: archiveName, requestKey: 'archived-card' })).data.id).toBe(work.id);
    expect((await request('work', 'POST', { sourceId: 'demo', changeName: 'feature', requestKey: 'create-feature' })).data.id).toBe(work.id);
  });
  it('연결 중 검증 실행과 검증 계획 변경을 막는다', async () => {
    const store = app.get(WorkStore), current = store.get(work.id)!; current.phase = 'implementation'; current.state = 'connecting'; store.save(current);
    expect((await request(`work/${work.id}/verify`, 'POST', { commandId: 'test' })).status).toBe(409);
    expect((await request(`work/${work.id}/verification-plan`, 'PUT', { commands: [{ id: 'test', command: process.execPath, args: [] }] })).status).toBe(409);
    expect((await request(`work/${work.id}/action`, 'POST', { action: 'implement' })).status).toBe(409);
    current.state = 'idle'; store.save(current);
  });
  it('실행 중 검증을 중단하면 성공으로 처리하지 않는다', async () => {
    // A fresh active work is required; the previous work was archived above.
    const docs = join(root, 'openspec', 'changes', 'interrupt-check');
    await mkdir(join(docs, 'specs', 'feature'), { recursive: true });
    for (const file of ['proposal.md', 'design.md', 'specs/feature/spec.md']) await writeFile(join(docs, file), '# plan\n');
    await writeFile(join(docs, 'tasks.md'), '- [ ] check\n');
    work = (await request('work', 'POST', { sourceId: 'demo', changeName: 'interrupt-check', requestKey: 'interrupt-check' })).data;
    await request(`work/${work.id}/action`, 'POST', { action: 'review' });
    await request(`work/${work.id}/action`, 'POST', { action: 'implement' });
    await expect.poll(async () => (await request(`work/${work.id}`)).data.state).toBe('idle');
    await request(`work/${work.id}/verification-plan`, 'PUT', { commands: [{ id: 'slow', command: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] }] });
    await request(`work/${work.id}/verify`, 'POST', { commandId: 'slow' });
    expect((await request(`work/${work.id}/interrupt`, 'POST', {})).status).toBe(200);
    await expect.poll(async () => (await request(`work/${work.id}`)).data.verifications.at(-1)?.status).toBe('interrupted');
  });
});
