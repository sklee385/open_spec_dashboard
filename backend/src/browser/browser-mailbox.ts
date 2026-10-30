import { copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute, sep, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ProjectResolver } from '../projects/resolver';
import { LegacyService } from '../legacy/legacy.service';
import { inspectWorkspacePath } from '../work/workspace-paths';
import type { Work, WorkStore } from '../work/store';
import { BrowserExecutionContexts, type BrowserExecutionContext } from './browser-execution-context';

const key = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
type Request = { id: string; op: 'run' | 'status' | 'cancel'; contextId?: string };
type Channel = { workId: string; root: string; directory: string; rootDev: number; rootIno: number; directoryDev: number; directoryIno: number; contextId: string; fallbackContextId?: string };
type Hosts = { resolver: () => ProjectResolver; contexts: () => BrowserExecutionContexts };
function readSmall(path: string, maximum = 4096) {
  const before = lstatSync(path); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw new Error('요청·증거 파일의 소유 또는 크기를 확인할 수 없습니다');
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) throw new Error('파일 소유가 변경되었습니다');
    const bytes = Buffer.alloc(maximum + 1); let size = 0, count: number;
    while ((count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) { size += count; if (size > maximum) throw new Error('파일 크기 한도를 초과했습니다'); }
    const after = lstatSync(path); if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 || after.size !== size || after.mtimeMs !== before.mtimeMs) throw new Error('파일을 읽는 동안 변경되었습니다');
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}
export function mailboxDirectory(root: string, create = false) {
  inspectWorkspacePath(root, []);
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
  private owner = randomUUID();
  private inflight = new Set<string>();
  private recovered = new Map<string, Set<string>>();
  private legacy?: LegacyService;
  private resolver?: ProjectResolver;
  private contexts?: BrowserExecutionContexts;
  constructor(private store: WorkStore, private execute: (id: string, input: { op: string }, context?: BrowserExecutionContext) => Promise<any>, private hosts?: Hosts) {}
  private targetResolver() { return this.hosts?.resolver() ?? (this.resolver ??= new ProjectResolver(this.legacy ??= new LegacyService(), this.store)); }
  private bindings() { return this.hosts?.contexts() ?? (this.contexts ??= new BrowserExecutionContexts(this.store, this.targetResolver(), () => 'standalone-host')); }
  private record(id: string) { const row = this.store.db.prepare('SELECT work_id,data FROM records WHERE id=?').get(id) as { work_id: string; data: string } | undefined; return row ? { ...JSON.parse(row.data), workId: row.work_id } : undefined; }
  private assertChannel(channel: Channel) {
    if (mailboxDirectory(channel.root) !== channel.directory) throw new Error('브라우저 통로가 변경되었습니다');
    const root = lstatSync(channel.root), directory = lstatSync(channel.directory);
    if (root.dev !== channel.rootDev || root.ino !== channel.rootIno || directory.dev !== channel.directoryDev || directory.ino !== channel.directoryIno) throw new Error('브라우저 통로의 실제 소유 경계가 변경되었습니다');
  }
  private write(channel: Channel, path: string, data: string | Buffer, replace = false) {
    this.assertChannel(channel); if (existsSync(path)) { readSmall(path, 2 * 1024 ** 2); if (!replace) return; }
    const temp = path + '.' + randomUUID() + '.tmp'; writeFileSync(temp, data, { flag: 'wx' }); this.assertChannel(channel); renameSync(temp, path);
  }
  private contextFile(channel: Channel) {
    const context = this.bindings().current(channel.workId);
    if (context.workExecutionPath !== channel.root) return;
    const path = join(channel.directory, 'context.json'), contents = JSON.stringify({ version: 1, contextId: context.contextId, workId: context.workId });
    if (!existsSync(path) || readSmall(path).toString('utf8') !== contents) this.write(channel, path, contents, true);
    channel.contextId = context.contextId;
  }
  prepare(work: Work) {
    const root = this.targetResolver().resolve(work.sourceId, work.id).root, directory = mailboxDirectory(root, true), rootStat = lstatSync(root), stat = lstatSync(directory), context = this.bindings().current(work.id);
    const previous = this.record(`browser-mailbox-channel:${work.id}`);
    const channel: Channel = { workId: work.id, root, directory, rootDev: rootStat.dev, rootIno: rootStat.ino, directoryDev: stat.dev, directoryIno: stat.ino, contextId: context.contextId, fallbackContextId: previous?.root === root ? previous.fallbackContextId : context.candidateId === null ? context.contextId : undefined };
    this.store.record(`browser-mailbox-channel:${work.id}`, work.id, 'browser-mailbox-channel', channel);
    const cli = join(directory, 'cli.cjs'); if (existsSync(cli)) readSmall(cli, 65536);
    const temp = join(directory, `${randomUUID()}.tmp`); copyFileSync(join(__dirname, '../../scripts/browser-verification.cjs'), temp); this.assertChannel(channel); renameSync(temp, cli);
    this.contextFile(channel); this.recover(channel); return directory;
  }
  start() { if (!this.timer) this.timer = setInterval(() => { try { this.poll(); } catch { /* Unavailable channels never grant execution. */ } }, 300).unref(); }
  private request(path: string, id: string): Request {
    const input = JSON.parse(readSmall(path).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.id !== id || !uuid(id) || !['run', 'status', 'cancel'].includes(input.op) || Object.keys(input).some(key => !['id', 'op', 'contextId'].includes(key)) || input.contextId !== undefined && (typeof input.contextId !== 'string' || !/^[a-f0-9]{64}$/.test(input.contextId))) throw new Error('브라우저 요청 형식이 다릅니다');
    return input;
  }
  private recover(channel: Channel, files = readdirSync(join(channel.directory, 'requests'))) {
    const channelKey = `${channel.workId}:${channel.root}`, processed = this.recovered.get(channelKey) ?? new Set<string>(); this.recovered.set(channelKey, processed); this.assertChannel(channel);
    for (const file of files.filter(file => /^[a-f0-9-]{36}\.json\.processing$/.test(file) && !processed.has(file)).slice(0, 64)) {
      const id = file.slice(0, 36); if (this.inflight.has(id)) continue;
      try {
        const input = this.request(join(channel.directory, 'requests', file), id), stored = this.record(`browser-mailbox-request:${id}`);
        if (stored && stored.workId !== channel.workId) continue;
        const observed = this.store.db.prepare("SELECT id,data FROM records WHERE work_id=? AND kind='browser-verification' AND json_extract(data,'$.mailboxRequestId')=? ORDER BY rowid DESC LIMIT 1").get(channel.workId, id) as { id: string; data: string } | undefined;
        const savedRun = observed ? { ...JSON.parse(observed.data), id: observed.id } : undefined, run = savedRun?.executionBinding?.contextId === input.contextId ? savedRun : undefined;
        const response = stored?.response ?? { requestId: id, contextId: input.contextId ?? null, runId: run?.id ?? null, success: false, result: { ...(run ?? {}), image: undefined, observedStatus: run?.status, status: 'interrupted', requestId: id, fresh: false }, error: '이전 처리 요청의 완료를 확인하지 못했습니다. 실행을 자동 반복하지 않습니다' };
        if (!stored?.response) this.store.record(`browser-mailbox-request:${id}`, channel.workId, 'browser-mailbox-request', { requestId: id, op: input.op, contextId: input.contextId ?? null, status: 'interrupted', response });
        this.write(channel, join(channel.directory, 'results', `${id}.json`), JSON.stringify(response));
      } catch { /* Invalid/shared processing files remain untouched and never execute. */ }
      finally { processed.add(file); }
    }
  }
  poll() {
    const channels = this.store.db.prepare("SELECT data FROM records WHERE kind='browser-mailbox-channel' ORDER BY rowid DESC LIMIT 1000").all() as { data: string }[];
    for (const row of channels) {
      const channel: Channel = JSON.parse(row.data);
      let files: string[];
      try { this.assertChannel(channel); files = readdirSync(join(channel.directory, 'requests')); this.recover(channel, files); this.contextFile(channel); } catch { continue; }
      for (const file of files.filter(file => /^[a-f0-9-]{36}\.json$/.test(file)).slice(0, 64)) {
        const path = join(channel.directory, 'requests', file), id = file.slice(0, 36);
        try {
          const input = this.request(path, id);
          if (existsSync(path + '.processing') || existsSync(join(channel.directory, 'results', file))) { renameSync(path, path + '.duplicate'); continue; }
          const existing = this.record(`browser-mailbox-request:${id}`);
          if (existing) {
            const response = existing.workId === channel.workId && existing.response ? existing.response : { requestId: id, success: false, result: { status: 'interrupted' }, error: '이미 처리되었거나 다른 업무에 속한 요청 ID입니다. 반복 실행하지 않습니다' };
            this.write(channel, join(channel.directory, 'results', file), JSON.stringify(response)); renameSync(path, path + '.duplicate'); continue;
          }
          const claimed = this.store.transaction(() => { if (this.record(`browser-mailbox-request:${id}`)) return false; this.store.record(`browser-mailbox-request:${id}`, channel.workId, 'browser-mailbox-request', { requestId: id, op: input.op, contextId: input.contextId ?? null, owner: this.owner, status: 'processing' }); return true; });
          if (!claimed) continue;
          writeFileSync(path + '.processing', JSON.stringify(input), { flag: 'wx' }); renameSync(path, path + '.submitted'); this.inflight.add(id); void this.respond(channel, input);
        } catch { try { renameSync(path, path + '.invalid'); } catch {} }
      }
    }
  }
  private async respond(channel: Channel, input: Request) {
    let response: any, binding: BrowserExecutionContext | undefined;
    try {
      const contextId = input.contextId ?? (input.op === 'run' ? undefined : channel.fallbackContextId);
      if (!contextId) throw new Error('호스트가 고정한 CLI 컨텍스트가 필요합니다. status/cancel은 업무 화면에서도 확인할 수 있습니다');
      const context = binding = this.bindings().load(channel.workId, contextId), value = await this.execute(channel.workId, { op: input.op }, { ...context, requestId: input.id });
      const result = value.result ? { ...value.result } : null;
      if (result?.image?.startsWith('data:image/jpeg;base64,')) {
        const expected = join(resolve(process.env.DATA_DIR || '../.data'), 'verification-environments', result.environmentId, 'evidence', `${result.id}.jpg`);
        if (key(expected) !== key(result.evidencePath ?? '')) throw new Error('호스트 증거 원본을 확인할 수 없습니다');
        inspectWorkspacePath(join(expected, '..'), []); const bytes = readSmall(expected, 1024 ** 2), inline = Buffer.from(result.image.slice('data:image/jpeg;base64,'.length), 'base64');
        if (createHash('sha256').update(bytes).digest('hex') !== createHash('sha256').update(inline).digest('hex')) throw new Error('화면 증거가 호스트 원본과 다릅니다');
        const path = join(channel.directory, 'results', `${input.id}.jpg`); this.write(channel, path, bytes); delete result.image; result.imagePath = path;
      }
      response = { ...value, requestId: input.id, contextId, runId: result?.id ?? null, success: value.success !== false && value.contextChanged !== true && !['failed', 'blocked', 'interrupted', 'stale'].includes(result?.status), result };
    } catch (error: any) { response = { requestId: input.id, contextId: input.contextId ?? null, success: false, error: error.message, result: { status: input.op === 'run' ? 'blocked' : 'interrupted' } }; }
    try {
      const published = this.store.transaction(() => {
        const current = this.record(`browser-mailbox-request:${input.id}`); if (current?.workId !== channel.workId || current.owner !== this.owner || current.status !== 'processing') return current?.response;
        if (binding && !this.bindings().isCurrent(binding)) response = { ...response, success: false, contextChanged: true, result: response.result ? { ...response.result, fresh: false, freshnessState: 'stale' } : null };
        this.store.record(`browser-mailbox-request:${input.id}`, channel.workId, 'browser-mailbox-request', { ...current, status: 'completed', response }); return response;
      });
      if (!this.closed && published) this.write(channel, join(channel.directory, 'results', `${input.id}.json`), JSON.stringify(published));
    } catch { /* Durable host result survives unavailable or replaced transport paths. */ }
    finally { this.inflight.delete(input.id); }
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); void this.legacy?.onModuleDestroy(); }
}
