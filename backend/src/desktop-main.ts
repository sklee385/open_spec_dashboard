import { createApplication } from './app';
import { DesktopLifecycle } from './desktop/lifecycle';
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDataOwnership } from './desktop/ownership';
import type { Server } from 'node:net';
let ownership: Server | undefined;

async function main() {
  if (!process.env.DESKTOP_TOKEN || !process.env.DATA_DIR || !process.env.CONFIG_PATH || !process.send) throw new Error('데스크톱 실행 환경이 필요합니다');
  ownership = await acquireDataOwnership(process.env.DATA_DIR);
  const app = await createApplication();
  const lifecycle = app.get(DesktopLifecycle);
  await app.listen(0, '127.0.0.1');
  process.send!({ type: 'ready', port: Number(new URL(await app.getUrl()).port) });
  let closing = false;
  process.on('message', async (message: any) => {
    if (message?.type !== 'shutdown' || closing) return;
    if (!lifecycle.locked || !lifecycle.status().idle) { process.send?.({ type: 'shutdown-error', message: '업무 유휴 상태와 종료 잠금이 필요합니다' }); return; }
    closing = true;
    try {
      app.getHttpServer().closeAllConnections(); // All work is idle and new mutations are locked; finish read-only SSE before Nest close.
      await app.close(); // Close WAL/DB before copying; no writes can be accepted after prepare.
      const backup = join(process.env.DATA_DIR!, '..', 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
      mkdirSync(backup, { recursive: true });
      cpSync(process.env.DATA_DIR!, join(backup, 'data'), { recursive: true });
      cpSync(process.env.CONFIG_PATH!, join(backup, 'config.json'));
      ownership?.close();
      process.send?.({ type: 'stopped', backup }, () => process.exit(0));
    } catch {
      ownership?.close();
      process.send?.({ type: 'shutdown-error', message: '정상 종료 또는 데이터 백업에 실패했습니다. 설치하지 않습니다.' }, () => process.exit(1));
    }
  });
}
main().catch(() => { ownership?.close(); process.send?.({ type: 'startup-error', message: '대화 서버를 준비하지 못했습니다. 로그와 데이터 경로를 확인해 주세요.' }); process.exitCode = 1; });
