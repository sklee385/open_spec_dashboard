import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDataOwnership } from '../src/desktop/ownership';
it('같은 저장소의 두 세션을 거절하고 소유자 종료 후 다시 획득한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-owner-'));
  const first = await acquireDataOwnership(dir);
  try { await expect(acquireDataOwnership(dir)).rejects.toThrow(); }
  finally { await new Promise<void>(resolve => first.close(() => resolve())); }
  const next = await acquireDataOwnership(dir);
  await new Promise<void>(resolve => next.close(() => resolve()));
});
