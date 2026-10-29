import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LegacyService } from '../src/legacy/legacy.service';
import { WorkspaceSettingsService } from '../src/work/workspace-settings.service';
import { DatabaseSync } from 'node:sqlite';

describe('공간 설정 저장', () => {
  let legacy: LegacyService, root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'workspace-settings-'));
    mkdirSync(join(root, 'openspec'));
    process.env.CONFIG_PATH = join(root, 'config.json');
    writeFileSync(process.env.CONFIG_PATH, JSON.stringify({ port: 13002, sources: [], extension: { retained: true } }));
    writeFileSync(join(root, 'ai-tools.json'), '{"custom":"unchanged"}');
    legacy = new LegacyService();
  });
  afterEach(async () => { await legacy?.onModuleDestroy(); delete process.env.CONFIG_PATH; });
  it('기존 설정을 보존하고 프로필과 정책을 원자 저장하여 다시 읽는다', async () => {
    const settings = new WorkspaceSettingsService(legacy), first = settings.read();
    expect(first).toMatchObject({ schemaVersion: 1, version: 0, roots: [], policy: { maxActiveWorks: 3, minimumFreeBytes: 5 * 1024 ** 3, retentionDays: 14 } });
    expect(first.profileId).toMatch(/^[a-f0-9-]{36}$/);
    const next = settings.update(first.version, draft => { draft.policy.maxActiveWorks = 2; });
    expect(next.version).toBe(1);
    await legacy.updateSources({ sources: [{ name: 'demo', path: './openspec' }] });
    expect(new WorkspaceSettingsService(legacy).read()).toEqual(next);
    expect(legacy.config()).toMatchObject({ port: 13002, sources: [{ name: 'demo', path: './openspec' }], extension: { retained: true } });
    expect(readFileSync(join(root, 'ai-tools.json'), 'utf8')).toBe('{"custom":"unchanged"}');
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it('두 프로세스의 오래된 저장과 잠긴 설정 저장을 거부하고 기존 내용을 보존한다', () => {
    const a = new WorkspaceSettingsService(legacy), b = new WorkspaceSettingsService(legacy);
    const version = a.read().version;
    b.update(version, draft => { draft.policy.retentionDays = 30; });
    expect(() => a.update(version, draft => { draft.policy.retentionDays = 1; })).toThrow(/다른 창/);
    const previous = readFileSync(legacy.configPath, 'utf8');
    const lock = new DatabaseSync(`${legacy.configPath}.lock.sqlite`);
    lock.exec('BEGIN IMMEDIATE');
    try {
      expect(() => b.update(1, () => {})).toThrow(/저장 중/);
      expect(readFileSync(legacy.configPath, 'utf8')).toBe(previous);
    } finally { lock.exec('ROLLBACK'); lock.close(); }
    expect(b.update(1, draft => { draft.policy.retentionDays = 60; }).version).toBe(2);
  });
  it('손상된 루트·중복 소유 정보는 초기값으로 덮어쓰지 않고 차단한다', () => {
    const settings = new WorkspaceSettingsService(legacy); settings.read();
    for (const roots of [[null], [{ rootId: 'invalid', path: 'relative' }]]) {
      const config = legacy.config(); config.workspaces!.roots = roots as any;
      writeFileSync(legacy.configPath, JSON.stringify(config));
      const original = readFileSync(legacy.configPath, 'utf8');
      expect(() => settings.read()).toThrow(/손상/);
      expect(readFileSync(legacy.configPath, 'utf8')).toBe(original);
    }
  });
  it('linked worktree의 외부 Git 관리 디렉터리도 보호 영역에 포함한다', () => {
    const common = join(root, 'shared-git'), gitdir = join(common, 'worktrees', 'demo');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(root, '.git'), `gitdir: ${gitdir}\n`); writeFileSync(join(gitdir, 'commondir'), '../..\n');
    const config = legacy.config(); config.sources = [{ name: 'demo', path: './openspec' }]; writeFileSync(legacy.configPath, JSON.stringify(config));
    expect(new WorkspaceSettingsService(legacy).protectedPaths()).toContain(resolve(common));
  });
});
