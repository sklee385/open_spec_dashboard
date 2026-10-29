import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/app';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';

describe('공간 설정 요청·확인 경계', () => {
  let app: INestApplication, base: string, root: string;
  const request = async (method = 'GET', suffix = '', body?: unknown) => {
    const response = await fetch(`${base}/api/workspace-settings${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'workspace-settings-api-'));
    process.env.CONFIG_PATH = join(root, 'config', 'config.json');
    process.env.DATA_DIR = join(root, 'data'); delete process.env.WORKSPACE_ROOT;
    app = await createApplication(); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); delete process.env.CONFIG_PATH; delete process.env.DATA_DIR; delete process.env.WORKSPACE_ROOT; });
  it('미확인 저장은 거부하고 검사만으로 폴더를 생성하지 않는다', async () => {
    const initial = await request(); expect(initial.status).toBe(200);
    expect(initial.data).toMatchObject({ source: 'unset', confirmed: false, editable: true });
    expect((await request('PUT', '', { version: initial.data.version, path: join(root, 'storage') })).status).toBe(400);
    // The test sandbox lives under the real installation. Use isolated fixture protection roots.
    vi.spyOn(app.get(WorkspaceSettingsService), 'protectedPaths').mockReturnValue([join(root, 'config'), join(root, 'data'), join(root, 'project'), join(root, 'install')]);
    const checked = await request('POST', '/check', { version: initial.data.version, path: join(root, 'storage') });
    expect(checked.status).toBe(201); expect(checked.data.token).toBeTruthy();
    expect(existsSync(join(root, 'storage'))).toBe(false);
    expect((await request('PUT', '', { version: initial.data.version, token: checked.data.token, confirmed: false })).status).toBe(400);
    const saved = await request('PUT', '', { version: initial.data.version, token: checked.data.token, confirmed: true });
    expect(saved.status).toBe(200); expect(saved.data).toMatchObject({ source: 'saved', confirmed: true, available: true, path: join(root, 'storage'), version: 1 });
    expect(readFileSync(process.env.CONFIG_PATH!, 'utf8')).toContain(saved.data.profileId);
    expect((await request('PUT', '', { version: 0, token: checked.data.token, confirmed: true })).status).toBe(409);
  });
  it('검사 토큰 변조·만료·버전 충돌·경로 교체를 거부한다', async () => {
    const view = (await request()).data;
    expect((await request('PUT', '', { version: view.version, token: 'forged', confirmed: true })).status).toBe(409);
    expect((await request('POST', '/check', { version: 0, path: join(root, 'other') })).status).toBe(409);
    const selected = join(root, 'replace'); mkdirSync(selected);
    const checked = (await request('POST', '/check', { version: view.version, path: selected })).data;
    renameSync(selected, join(root, 'old')); mkdirSync(selected);
    expect((await request('PUT', '', { version: view.version, token: checked.token, confirmed: true })).status).toBe(409);
    expect(existsSync(join(selected, `openspecboard-${view.profileId}`))).toBe(false);
    const expiring = (await request('POST', '/check', { version: view.version, path: join(root, 'expired') })).data;
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_000);
    try { expect((await request('PUT', '', { version: view.version, token: expiring.token, confirmed: true })).status).toBe(409); }
    finally { now.mockRestore(); }
  });
  it('환경 고정은 편집을 차단하지만 최초 검사·확인을 요구한다', async () => {
    process.env.WORKSPACE_ROOT = join(root, 'environment');
    const view = (await request()).data;
    expect(view).toMatchObject({ source: 'environment', editable: false, confirmed: false, path: process.env.WORKSPACE_ROOT });
    expect((await request('POST', '/check', { version: view.version, path: join(root, 'not-environment') })).status).toBe(409);
    const check = await request('POST', '/check', { version: view.version, path: view.path });
    const saved = await request('PUT', '', { version: view.version, token: check.data.token, confirmed: true });
    expect(saved.data).toMatchObject({ source: 'environment', confirmed: true, editable: false });
    delete process.env.WORKSPACE_ROOT;
  });
  it('환경 경로의 구분자·후행 슬래시를 정규화하여 저장 후 확인 상태를 유지한다', async () => {
    const canonical = join(root, 'environment-normalized');
    process.env.WORKSPACE_ROOT = `${canonical.replace(/\\/g, '/')}/`;
    const view = (await request()).data;
    const checked = await request('POST', '/check', { version: view.version, path: canonical });
    expect(checked.status).toBe(201);
    const saved = await request('PUT', '', { version: view.version, token: checked.data.token, confirmed: true });
    expect(saved.status).toBe(200); expect(saved.data).toMatchObject({ confirmed: true, path: canonical });
    expect((await request()).data).toMatchObject({ confirmed: true, path: canonical });
    delete process.env.WORKSPACE_ROOT;
  });
  it('확인한 관리 폴더 유실과 소유 정보 교체를 사용 가능으로 표시하지 않는다', async () => {
    const current = (await request()).data;
    renameSync(current.managedPath, `${current.managedPath}-preserved`);
    const missing = (await request()).data;
    expect(missing.available).toBe(false); expect(missing.error).toBeTruthy();
    renameSync(`${current.managedPath}-preserved`, current.managedPath);
    expect((await request()).data.available).toBe(true);
    const identityPath = join(current.managedPath, 'identity.json'), identity = readFileSync(identityPath, 'utf8');
    writeFileSync(identityPath, identity.replace(current.selectedRootId, '00000000-0000-0000-0000-000000000000'));
    expect((await request()).data.available).toBe(false);
    writeFileSync(identityPath, identity); expect((await request()).data.available).toBe(true);
  });
});
