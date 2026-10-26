import { globSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Recover an index miss from an existing, verified active-session file only. */
export async function findRollout(id: string, project: string, home = process.env.CODEX_HOME || join(homedir(), '.codex')): Promise<string | undefined> {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) return;
  const root = resolve(home, 'sessions');
  const matches: string[] = [];
  for (const file of globSync(`**/rollout-*-${id}.jsonl`, { cwd: root })) {
    let handle;
    try {
      const path = await realpath(join(root, file)), within = relative(root, path);
      if (isAbsolute(within) || within.startsWith('..')) continue;
      handle = await open(path, 'r');
      const buffer = Buffer.alloc(1024 * 1024), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const header = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]);
      const sameProject = process.platform === 'win32' ? resolve(header.payload?.cwd || '').toLowerCase() === resolve(project).toLowerCase() : resolve(header.payload?.cwd || '') === resolve(project);
      if (header.type === 'session_meta' && header.payload?.id === id && typeof header.payload.cwd === 'string' && sameProject) matches.push(path);
    } catch { /* An unreadable or mismatched file is never used as replacement history. */ }
    finally { await handle?.close(); }
  }
  if (matches.length > 1) throw new Error('동일한 대화 원본이 여러 개입니다. 기존 기록을 확인해 주세요. 새 대화는 만들지 않았습니다.');
  return matches[0];
}
