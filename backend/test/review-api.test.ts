import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkStore } from '../src/work/store';
import * as files from '../src/files';

let app: INestApplication, base: string, root: string, work: any;
const get = async (path: string) => { const response = await fetch(`${base}/api/${path}`); return { status: response.status, data: await response.json() }; };
const changePath = 'changes/demo%2Ffeature/review-items';
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'review-api-'));
  for (const name of ['feature', 'other']) {
    const dir = join(root, 'openspec/changes', name);
    mkdirSync(join(dir, 'specs/feature'), { recursive: true });
    writeFileSync(join(dir, 'proposal.md'), `- [review:confirm] ${name}\n`);
    writeFileSync(join(dir, 'design.md'), '# 設計');
    writeFileSync(join(dir, 'tasks.md'), '- [ ] 実装');
    writeFileSync(join(dir, 'specs/feature/spec.md'), '- [review:decision] 選択');
  }
  process.env.CONFIG_PATH = join(root, 'config.json'); process.env.DATA_DIR = join(root, 'data');
  writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ sources: [{ name: 'demo', path: './openspec' }] }));
  app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  const response = await fetch(`${base}/api/work`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: 'demo', changeName: 'feature', requestKey: 'review-test' }) }); work = await response.json();
});
afterAll(async () => { await app?.close(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; });
it('두 API가 같은 결과를 주고 다른 업무를 격리하며 검토 상태를 보존한다', async () => {
  const store = app.get(WorkStore), current = store.get(work.id)!; current.reviewedVersion = 'reviewed'; store.save(current);
  const change = await get(changePath), room = await get(`work/${work.id}/review-items`);
  expect(change.status).toBe(200); expect(room.data).toEqual(change.data);
  expect(change.data.items.map((x: any) => x.text)).toEqual(['feature', '選択']);
  expect(Object.keys(change.data.documentVersions)).toHaveLength(4);
  expect(store.get(work.id)?.reviewedVersion).toBe('reviewed'); expect(store.get(work.id)?.phase).toBe('planning');
});
it('잘못된 ID·업무·경로를 거부한다', async () => {
  expect((await get('changes/demo%2F..%2Fother/review-items')).status).toBe(400);
  expect((await get('work/missing/review-items')).status).toBe(404);
  expect((await get('changes/demo%2Fmissing/review-items')).status).toBe(404);
});
it('누락 문서와 권한 실패를 부분 오류로 알리고 복구·삭제·이름 변경을 반영한다', async () => {
  rmSync(join(root, 'openspec/changes/feature/design.md'));
  const read = files.textFile;
  const spy = vi.spyOn(files, 'textFile').mockImplementation(path => {
    if (path.endsWith('proposal.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return read(path);
  });
  try {
    const result = await get(changePath);
    expect(result.status).toBe(200);
    expect(result.data.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'proposal.md', code: 'EACCES' }), expect.objectContaining({ path: 'design.md', code: 'ENOENT' })]));
    expect(result.data.items).toHaveLength(1);
  } finally { spy.mockRestore(); }
  writeFileSync(join(root, 'openspec/changes/feature/proposal.md'), '- [review:choice] 변경\n');
  rmSync(join(root, 'openspec/changes/feature/specs/feature/spec.md'));
  const result = await get(changePath);
  expect(result.data.items.map((x: any) => x.text)).toEqual(['변경']);
  expect(result.data.documentVersions).not.toHaveProperty('specs/feature/spec.md');
});
