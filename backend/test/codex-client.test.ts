import { afterEach, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { CodexClient } from '../src/codex/client';
const clients: CodexClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); delete process.env.CODEX_BIN; delete process.env.CODEX_ARGS; });
it('요청 오류를 전달하고 프로세스 재연결 세대를 구분한다', async () => {
  process.env.CODEX_BIN = process.execPath; process.env.CODEX_ARGS = JSON.stringify([resolve('test/fixtures/codex.cjs')]);
  const client = new CodexClient(); clients.push(client); await client.ready(); const generation = client.generation;
  await expect(client.rpc('test/error')).rejects.toThrow('복원 실패 테스트');
  await expect(client.rpc('test/exit')).rejects.toThrow('종료');
  await client.ready(); expect(client.generation).not.toBe(generation);
  expect(await client.rpc('account/read')).toMatchObject({ account: { type: 'chatgpt' } });
});
it('연결 실패는 재시도할 수 있고 미처리 요청을 남기지 않는다', async () => {
  process.env.CODEX_BIN = 'missing-codex-binary-for-test'; process.env.CODEX_ARGS = '[]';
  const client = new CodexClient(); clients.push(client);
  await expect(client.ready()).rejects.toThrow();
  process.env.CODEX_BIN = process.execPath; process.env.CODEX_ARGS = JSON.stringify([resolve('test/fixtures/codex.cjs')]);
  await client.ready(); expect(client.requests.size).toBe(0);
});
