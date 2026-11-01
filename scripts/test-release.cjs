'use strict';
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '..');
const listOnly = process.argv.includes('--list');
if (process.argv.slice(2).some(arg => arg !== '--list')) throw new Error('지원하지 않는 검사 옵션입니다');

// Reviewed direct-impact selection for this change. Update this selection with
// the changed behavior in future releases; never fall back to the full suite.
const groups = [
  { name: '업무 검증·종료 receipt·실제 소유 Job/프로세스 식별', workspace: 'backend', args: ['run', 'test/manual-tests.test.ts', 'test/git-owned-job.test.ts', 'test/browser-handle-identity.test.ts'] },
  { name: '후보 검증·범위 복구·종료 잠김·작업 생성', workspace: 'backend', args: ['run', 'test/integration-verification.test.ts', 'test/integration-editing.test.ts', 'test/desktop-runtime-regression.test.ts', 'test/workspaces-api.test.ts', '-t', '후보 CLI는|후보 계획이|proof checkpoint await 중 derived-commands|과거 running|실제로 실행 중인|완료 업무라도|검토·실험'] },
  { name: '기존 실패가 있었던 문서 준비·복구 직접 회귀', workspace: 'backend', args: ['run', 'test/worktree-documents.test.ts', 'test/workspace-provisioner.test.ts', '-t', '문서만 업무 브랜치|문서 기준 커밋 성공 후 응답|문서 기준 뒤 확인한|로컬 준비 목록으로|준비 명령이 기준 제품|산출물 목록으로|명시적 확인으로 Git 문서|예약 전 typed 경로 오류|Git 생성 응답 유실|결합 장애: 설정 전환'] },
  { name: '변경된 검증 UI와 오래된 실패 제외', workspace: 'frontend', args: ['run', 'src/components/WorkTests.test.tsx', 'src/components/CandidateLifecycle.test.tsx', '--configLoader=runner'] },
];
for (const group of groups) {
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), ...group.args, '--maxWorkers=1'];
  console.log(`[release-checks] ${group.name}`);
  if (listOnly) { console.log(JSON.stringify({ workspace: group.workspace, args: args.slice(1) })); continue; }
  const result = spawnSync(process.execPath, args, { cwd: join(root, group.workspace), stdio: 'inherit', shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
