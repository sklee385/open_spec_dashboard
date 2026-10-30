import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../src/app';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { WorkStore } from '../src/work/store';
import { OpenSpecService } from '../src/openspec/openspec.service';
let app: any, base: string, root: string, work: any;
const request = async (path: string, body?: any) => { const res = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: res.status, data: await res.json() }; };
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pa-')); const docs = join(root, 'source/openspec/changes/feature'); mkdirSync(join(docs, 'specs/feature'), { recursive: true }); mkdirSync(join(root, 'config'));
  for (const name of ['proposal.md', 'design.md', 'tasks.md', 'specs/feature/spec.md']) writeFileSync(join(docs, name), '# Plan\n');
  process.env.CONFIG_PATH = join(root, 'config/config.json'); process.env.DATA_DIR = join(root, 'data'); delete process.env.WORKSPACE_ROOT; delete process.env.OPENSPEC_WORKTREE_EXPERIMENTAL;
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: join(root, 'source/openspec') }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  const settings = app.get(WorkspaceSettingsService); vi.spyOn(settings, 'protectedPaths').mockReturnValue([join(root, 'source'), join(root, 'config'), join(root, 'data')]);
  const initial = settings.read(), checked = settings.check({ version: initial.version, path: join(root, 'storage') }); settings.save({ version: initial.version, token: checked.token, confirmed: true });
  work = (await request('work', { sourceId: 'demo', changeName: 'feature', requestKey: 'feature' })).data;
});
afterAll(async () => { await app?.close(); for (const key of ['CONFIG_PATH', 'DATA_DIR', 'OPENSPEC_WORKTREE_EXPERIMENTAL']) delete process.env[key]; });
it('검토·실험 허용·복사 방식 확인을 모두 요구하고 상태·기준·복구를 조회한다', async () => {
  const endpoint = `work/${work.id}/workspace`;
  expect((await request(`${endpoint}/prepare`, { requestKey: 'p', confirmed: true })).status).toBe(409);
  expect((await request(`work/${work.id}/action`, { action: 'review' })).status).toBe(200);
  expect((await request(endpoint)).data).toMatchObject({ status: 'unprepared', experimentalEnabled: false });
  expect((await request(`${endpoint}/prepare`, { requestKey: 'p', confirmed: true })).status).toBe(409);
  process.env.OPENSPEC_WORKTREE_EXPERIMENTAL = '1';
  expect((await request(`${endpoint}/preview`)).data.git).toMatchObject({ state: 'not-git', copyEligible: true });
  expect((await request(`${endpoint}/prepare`, { requestKey: 'p' })).status).toBe(409);
  const ready = await request(`${endpoint}/prepare`, { requestKey: 'p', confirmed: true }); expect(ready.status).toBe(200); expect(ready.data).toMatchObject({ kind: 'copy', legacy: false, status: 'ready', available: true });
  const before = app.get(WorkStore).get(work.id); expect(existsSync(before.executionPath)).toBe(true);
  writeFileSync(join(before.executionPath, '.env'), 'TOKEN=fixture-local');
  expect((await request(`projects/demo/file?workId=${work.id}&path=.env`)).status).toBe(403);
  linkSync(join(before.executionPath, '.env'), join(before.executionPath, 'safe.txt'));
  expect((await request(`projects/demo/file?workId=${work.id}&path=safe.txt`)).status).toBe(403);
  const inaccessible = (await request(`work/${work.id}`)).data;
  expect(inaccessible.changeReport.source).toBe('unavailable'); expect(JSON.stringify(inaccessible)).not.toContain('fixture-local');
  const recovered = await request(`${endpoint}/recover`, { requestKey: 'p', confirmed: true }); expect(recovered.status).toBe(200); expect(recovered.data.workspaceId).toBe(ready.data.workspaceId);
  expect((await request(`${endpoint}/prepare`, { requestKey: 'different', confirmed: true })).status).toBe(409);
  expect(app.get(WorkStore).get(work.id).executionPath).toBe(before.executionPath);
  expect((await request('work/not-owned/workspace')).status).toBe(404);
  const inspect = vi.spyOn(app.get(OpenSpecService), 'inspect').mockResolvedValue({ ok: true, code: 0, stdout: '{}', stderr: '' });
  try {
    expect((await request(`work/${work.id}/openspec?operation=context`)).status).toBe(200);
    expect(inspect).toHaveBeenLastCalledWith(before.executionPath, 'feature', 'context', undefined);
    const broken = { ...before }; delete broken.executionPath; app.get(WorkStore).save(broken);
    expect((await request(`work/${work.id}/document?path=proposal.md`)).status).toBe(409);
    expect((await request(`work/${work.id}/openspec?operation=context`)).status).toBe(409);
  } finally { inspect.mockRestore(); app.get(WorkStore).save(before); }
});

it('정리 API는 미리보기·저장 결과를 읽고 임의 경로·force 요청을 삭제 없이 거부한다',async()=>{
 const endpoint='work/'+work.id+'/workspace/cleanup',before=JSON.stringify(app.get(WorkStore).get(work.id));
 expect(await request(endpoint+'/preview')).toMatchObject({status:200,data:{canRemove:false,version:null}});
 expect(await request(endpoint)).toMatchObject({status:200,data:{receipt:null}});
 expect((await request(endpoint+'/preview?path=other')).status).toBe(400);expect((await request(endpoint+'?path=other')).status).toBe(400);expect((await request(endpoint+'?candidateId=wrong')).status).toBe(400);
 expect((await request(endpoint+'/preview?candidateId=wrong')).status).toBe(400);
 expect((await request(endpoint,{requestKey:'key',token:'token',expectedVersion:'version',confirmed:true,force:true})).status).toBe(400);
 expect((await request('work/not-owned/workspace/cleanup/preview')).status).toBe(404);
 expect(JSON.stringify(app.get(WorkStore).get(work.id))).toBe(before);
});
