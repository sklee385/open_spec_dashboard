import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LegacyService } from '../legacy/legacy.service';
import { ConflictException, Optional } from '@nestjs/common';
import { WorkStore } from '../work/store';
import { FileResults } from '../work/file-results';
export interface ResolvedProject { sourceId: string; root: string; gitRoot: string | null; commonDir: string | null; gitAvailable: boolean; boundary: boolean; }
@Injectable()
export class ProjectResolver {
  constructor(@Inject(LegacyService) private readonly legacy: LegacyService, @Optional() @Inject(WorkStore) private readonly store?: WorkStore) {}
  resolve(sourceId: string, workId?: string): ResolvedProject {
    if (typeof sourceId !== 'string' || !sourceId) throw new NotFoundException('Project not found');
    const source = this.legacy.sources().find(s => s.id === sourceId && s.valid);
    if (!source) throw new NotFoundException('Project not found');
    let root: string;
    try { const spec = realpathSync(source.path); if (!statSync(spec).isDirectory()) throw new Error(); root = realpathSync(dirname(spec)); }
    catch { throw new NotFoundException('Project directory not found'); }
    if (workId !== undefined) {
      if (typeof workId !== 'string' || !workId || !this.store) throw new NotFoundException('업무 공간을 찾을 수 없습니다');
      const work = this.store.get(workId);
      if (!work || work.sourceId !== sourceId) throw new NotFoundException('이 프로젝트에 연결된 업무 공간이 없습니다');
      if (['completed', 'archived'].includes(work.phase)) throw new ConflictException('진행 중인 업무 공간을 선택해 주세요');
      if (!samePath(realpathSync(work.projectPath), root)) throw new ConflictException('업무의 원본 프로젝트 경로가 변경되었습니다');
      root = new FileResults(this.store).path(work);
    }
    const git = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), windowsHide: true, shell: false, timeout: 5000, maxBuffer: 65536 });
    const available = git(['--version']);
    const top = git(['rev-parse', '--show-toplevel']);
    let gitRoot: string | null = null, commonDir: string | null = null;
    if (top.status === 0) {
      try {
        gitRoot = realpathSync(top.stdout.replace(/\r?\n$/, ''));
        const common = git(['rev-parse', '--git-common-dir']);
        if (common.status === 0) commonDir = realpathSync(resolve(root, common.stdout.replace(/\r?\n$/, '')));
      } catch { gitRoot = null; commonDir = null; }
    }
    return { sourceId, root, gitRoot, commonDir, gitAvailable: !available.error && available.status === 0, boundary: gitRoot !== null && samePath(root, gitRoot) };
  }
}
function samePath(a: string, b: string) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
