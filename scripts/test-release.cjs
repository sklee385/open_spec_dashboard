'use strict';
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '..');
const listOnly = process.argv.includes('--list');
const managementOnly = process.argv.includes('--work-management');
if (process.argv.slice(2).some(arg => !['--list', '--work-management'].includes(arg))) throw new Error('지원하지 않는 검사 옵션입니다');

// Reviewed direct-impact selection for this change. Update this selection with
// the changed behavior in future releases; never fall back to the full suite.
const managementGroups = [
  { name: '수동 관리 API·CAS·중복 방지·실행 보존 및 기존 완료 가드', workspace: 'backend', args: ['run', 'test/work-management.test.ts', 'test/workflow.test.ts'] },
  { name: '조회 지연·취소·수동 관리·복구·보드 및 번역 계약', workspace: 'frontend', args: ['run', 'src/components/WorkManagement.test.tsx', 'src/components/WorkRoomResponsiveness.test.tsx', 'src/components/WorkRoom.test.tsx', 'src/components/WorkRoomPolling.test.tsx', 'src/components/WorkRoomAttention.test.tsx', 'src/components/WorkRoomRecovery.test.tsx', 'src/hooks/useChanges.test.ts', 'src/i18n/contracts.test.tsx', '--configLoader=runner'] },
];
// Keep the prior release selection available. The current release explicitly
// selects its direct impact paths; packaged daily navigation smoke is unchanged.
const previousGroups = [
  { name: '읽기 전용 일일 집계·현재 상태 근거·이력 페이지', workspace: 'backend', args: ['run', 'test/daily-dashboard.test.ts'] },
  { name: '현황판·원문 시각·이동 및 직접 영향 질문/초안/헤더', workspace: 'frontend', args: ['run', 'src/components/DailyDashboard.test.tsx', 'src/lib/workConversation.test.ts', 'src/DailyApp.test.tsx', 'src/components/WorkRoom.test.tsx', 'src/AttentionApp.test.tsx', 'src/components/WorkRoomAttention.test.tsx', 'src/components/WorkRoomPolling.test.tsx', 'src/components/HeaderVersion.test.tsx', 'src/i18n/i18n.test.tsx', '--configLoader=runner'] },
];
const groups = managementOnly ? managementGroups : previousGroups;

for (const group of groups) {
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), ...group.args, '--maxWorkers=1'];
  console.log(`[release-checks] ${group.name}`);
  if (listOnly) { console.log(JSON.stringify({ workspace: group.workspace, args: args.slice(1) })); continue; }
  const result = spawnSync(process.execPath, args, { cwd: join(root, group.workspace), stdio: 'inherit', shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
