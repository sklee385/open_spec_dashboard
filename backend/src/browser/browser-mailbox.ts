import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileResults } from '../work/file-results';
import type { Work, WorkStore } from '../work/store';

export function mailboxDirectory(root: string, create = false) {
  const directory = join(root, '.tools', 'browser-verification');
  for (const path of [join(root, '.tools'), directory, join(directory, 'requests'), join(directory, 'results')]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('브라우저 요청 폴더에 링크를 사용할 수 없습니다');
    if (create) mkdirSync(path, { recursive: true });
    if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new Error('브라우저 요청 폴더를 확인할 수 없습니다');
  }
  const rel = relative(realpathSync(root), realpathSync(directory));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('브라우저 요청 경로가 업무 범위를 벗어났습니다');
  return directory;
}
export class BrowserMailbox {
  private timer?: NodeJS.Timeout;
  private closed = false;
  constructor(private store: WorkStore, private execute: (id: string, input: { op: string }) => Promise<any>) {}
  prepare(work: Work) {
    const directory = mailboxDirectory(new FileResults(this.store).path(work), true);
    const temp = join(directory, `${randomUUID()}.tmp`);
    copyFileSync(join(__dirname, '../../scripts/browser-verification.cjs'), temp);
    renameSync(temp, join(directory, 'cli.cjs'));
    return directory;
  }
  start() { if (!this.timer) this.timer = setInterval(() => { try { this.poll(); } catch { /* Closing or unavailable work never grants access. */ } }, 300).unref(); }
  poll() {
    for (const work of this.store.list().filter(work => work.browserScenario && !['completed', 'archived'].includes(work.phase))) {
      let directory: string; try { directory = mailboxDirectory(new FileResults(this.store).path(work)); } catch { continue; }
      for (const file of readdirSync(join(directory, 'requests')).filter(file => /^[a-f0-9-]{36}\.json$/.test(file)).slice(0, 64)) {
        const path = join(directory, 'requests', file);
        try {
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) { renameSync(path, path + '.invalid'); continue; }
          const content = readFileSync(path, 'utf8');
          let input: any; try { input = JSON.parse(content); } catch { renameSync(path, path + '.invalid'); continue; }
          if (!input || typeof input !== 'object' || Array.isArray(input) || input.id + '.json' !== file || !['run', 'status', 'cancel'].includes(input.op) || Object.keys(input).some(key => !['id', 'op'].includes(key))) { renameSync(path, path + '.invalid'); continue; }
          if (existsSync(path + '.processing') || existsSync(join(directory, 'results', file))) { renameSync(path, path + '.duplicate'); continue; }
          // Claim exclusively before any await; a crash or competing poller cannot replay it.
          writeFileSync(path + '.processing', content, { flag: 'wx' });
          renameSync(path, path + '.submitted');
          void this.respond(work, directory, input);
        } catch { /* A bad or concurrently changed request never blocks another work. */ }
      }
    }
  }
  private async respond(work: Work, directory: string, input: { id: string; op: string }) {
    let response: any;
    try {
      const value = await this.execute(work.id, { op: input.op });
      const result = value.result ? { ...value.result } : null;
      // Recheck the directory before every write; workspace files are untrusted.
      if (mailboxDirectory(new FileResults(this.store).path(work)) !== directory) throw new Error();
      if (result?.image?.startsWith('data:image/jpeg;base64,')) {
        const name = `${input.id}.jpg`, path = join(directory, 'results', name);
        writeFileSync(path, Buffer.from(result.image.slice('data:image/jpeg;base64,'.length), 'base64'), { flag: 'wx' });
        delete result.image; result.imagePath = path;
      }
      response = { success: !['failed', 'blocked', 'interrupted', 'stale'].includes(result?.status), ...value, result };
    } catch (error) { response = { success: false, error: error instanceof Error ? error.message : '브라우저 요청 처리 실패' }; }
    if (this.closed) return;
    try {
      if (mailboxDirectory(new FileResults(this.store).path(work)) !== directory) return;
      const temp = join(directory, 'results', `${randomUUID()}.tmp`), path = join(directory, 'results', `${input.id}.json`);
      writeFileSync(temp, JSON.stringify(response), { flag: 'wx' });
      if (!existsSync(path)) renameSync(temp, path);
    } catch { /* No fallback writes outside the work's verified folder. */ }
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); }
}
