'use strict';
const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '..');
const listOnly = process.argv.includes('--list');
if (process.argv.slice(2).some(arg => arg !== '--list')) throw new Error('지원하지 않는 검사 옵션입니다');

// Reviewed direct-impact selection for this change. Update this selection with
// the changed behavior in future releases; never fall back to the full suite.
const groups = [
  { name: '읽기 전용 일일 집계·현재 상태 근거·이력 페이지', workspace: 'backend', args: ['run', 'test/daily-dashboard.test.ts'] },
  { name: '현황판·원문 시각·이동 및 직접 영향 질문/초안/헤더', workspace: 'frontend', args: ['run', 'src/components/DailyDashboard.test.tsx', 'src/lib/workConversation.test.ts', 'src/DailyApp.test.tsx', 'src/components/WorkRoom.test.tsx', 'src/AttentionApp.test.tsx', 'src/components/WorkRoomAttention.test.tsx', 'src/components/WorkRoomPolling.test.tsx', 'src/components/HeaderVersion.test.tsx', 'src/i18n/i18n.test.tsx', '--configLoader=runner'] },
];

for (const group of groups) {
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), ...group.args, '--maxWorkers=1'];
  console.log(`[release-checks] ${group.name}`);
  if (listOnly) { console.log(JSON.stringify({ workspace: group.workspace, args: args.slice(1) })); continue; }
  const result = spawnSync(process.execPath, args, { cwd: join(root, group.workspace), stdio: 'inherit', shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
