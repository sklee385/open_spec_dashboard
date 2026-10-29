import { ConflictException } from '@nestjs/common';
import type { Work, WorkStore } from './store';
import { WorkspaceService } from './workspace.service';
import { within } from '../files';
import { inspectWorkspacePath } from './workspace-paths';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
/** Cwd is also an implicit sandbox write root, so planning uses the change itself. */
export function aiExecutionContext(store: WorkStore, work: Work, phase = work.phase) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(work.changeName)) throw new ConflictException('업무 변경 문서 식별이 올바르지 않습니다.');
  const spaces = new WorkspaceService(store), implementation = ['implementation', 'verification'].includes(phase);
  const projectRoot = implementation || spaces.hasSpace(work) ? spaces.path(work) : work.projectPath;
  const changeRoot = within(projectRoot, `openspec/changes/${work.changeName}`);
  const inspected = inspectWorkspacePath(changeRoot, []);
  if (!inspected.exists) throw new ConflictException('업무 변경 문서 경로가 없어 복구가 필요합니다. 원본으로 대체하지 않습니다.');
  if (!implementation) {
    let count = 0;
    const inspect = (path: string) => {
      if (++count > 10000) throw new ConflictException('계획 문서 소유 검사 한도를 초과했습니다.');
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new ConflictException('링크로 공유된 계획 문서는 쓸 수 없습니다. 독립 문서로 복구해 주세요.');
      if (stat.isDirectory()) for (const entry of readdirSync(path)) inspect(join(path, entry));
    };
    inspect(changeRoot);
  }
  return { projectRoot, changeRoot, cwd: implementation ? projectRoot : changeRoot, writableRoots: [implementation ? projectRoot : changeRoot], planning: !implementation };
}
export function aiScopeInstructions(context: ReturnType<typeof aiExecutionContext>) {
  return context.planning
    ? `계획 문서 쓰기 범위: ${context.changeRoot}\n제품 참조 경로: ${context.projectRoot}\n해당 변경의 proposal.md·design.md·tasks.md·specs/·source-ideas/·.openspec.yaml 등 계획 문서만 작성한다. 원본/업무 제품 파일·다른 변경·Git index/HEAD는 수정하지 않는다. 쓰기 권한 확대나 제품 구현은 별도 사용자 구현 시작 지시 전 요청하지 않는다.`
    : `업무 실행 공간: ${context.projectRoot}\n저장된 업무 공간에서만 구현·검증한다. 원본·다른 업무·Git 공통 관리 파일을 직접 수정하거나 원본 반영·완료·보관을 자동 수행하지 않는다. Git index/ref 변경과 통합은 앱의 명시적 절차를 사용한다.`;
}
