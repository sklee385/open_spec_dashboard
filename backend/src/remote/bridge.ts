import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmodSync, closeSync, openSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Target { list(): unknown; get(id: string): unknown; execute(action: string, id: string, body: any): unknown; }
interface Lifecycle { locked: boolean; beginRequest(kind: string, workId?: string): () => void; }
interface Command { requestId: string; workId: string; action: string; body: any; fingerprint: string; status: 'accepted' | 'running' | 'completed' | 'failed' | 'uncertain'; createdAt: string; updatedAt: string; result?: unknown; error?: string; errorStatus?: number; }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const actions = ['message', 'answer', 'approval', 'interrupt', 'reconnect', 'recover-session', 'cancel-session-recovery'];
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
function canonical(value: any): string { return JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : value); }
/** Dedicated authenticated loopback transport. Never receives or forwards the desktop token. */
export class RemoteBridge {
  readonly connectionPath: string;
  private readonly commandsPath: string;
  private readonly secret = randomBytes(32).toString('hex');
  private readonly commands = new Map<string, Command>();
  private readonly active = new Map<string, string>();
  private server?: Server;
  private ownerPath: string;
  private ownsLock = false;
  constructor(directory: string, private readonly target: Target, private readonly lifecycle: Lifecycle) {
    this.connectionPath = join(resolve(directory), 'remote-connection.json'); this.commandsPath = join(resolve(directory), 'remote-commands'); this.ownerPath = join(resolve(directory), 'remote-owner.json');
  }
  async start() {
    mkdirSync(this.commandsPath, { recursive: true, mode: 0o700 });
    if (existsSync(this.ownerPath)) {
      const owner = JSON.parse(readFileSync(this.ownerPath, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw Error('원격 연결 소유자를 확인할 수 없습니다');
      let alive = true; try { process.kill(owner.pid, 0); } catch (error: any) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw Error('다른 Board가 원격 연결을 소유하고 있습니다');
      unlinkSync(this.ownerPath);
    }
    const ownerHandle = openSync(this.ownerPath, 'wx', 0o600);
    try { writeFileSync(ownerHandle, JSON.stringify({ pid: process.pid, nonce: this.secret })); this.ownsLock = true; } finally { closeSync(ownerHandle); }
    for (const file of readdirSync(this.commandsPath).filter(file => uuid.test(file.replace(/\.json$/, '')) && file.endsWith('.json'))) {
      const row: Command = JSON.parse(readFileSync(join(this.commandsPath, file), 'utf8'));
      if (!row || !uuid.test(row.requestId) || row.requestId !== file.slice(0, -5) || !/^[a-f0-9]{64}$/.test(row.fingerprint) || !['accepted','running','completed','failed','uncertain'].includes(row.status)) throw Error('원격 명령 기록이 손상되었습니다');
      if (['accepted', 'running'].includes(row.status)) { row.status = 'uncertain'; row.error = '서버가 재시작되어 실행 결과 확인이 필요합니다. 자동 재실행하지 않습니다.'; this.save(row); }
      this.commands.set(row.requestId, row);
    }
    const server = this.server = createServer((req, res) => { void this.handle(req, res); });
    server.maxHeadersCount = 32; server.requestTimeout = 10000; server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error('원격 연결을 열 수 없습니다');
    this.atomic(this.connectionPath, { version: 1, url: `http://127.0.0.1:${address.port}`, secret: this.secret, pid: process.pid });
  }
  async close() {
    const server = this.server; this.server = undefined;
    if (server) { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
    if (this.ownsLock) { this.ownsLock = false; try { if (JSON.parse(readFileSync(this.ownerPath, 'utf8')).nonce === this.secret) unlinkSync(this.ownerPath); } catch { /* Preserve unknown ownership. */ } }
    if (existsSync(this.connectionPath)) { try { if (JSON.parse(readFileSync(this.connectionPath, 'utf8')).secret === this.secret) unlinkSync(this.connectionPath); } catch { /* Another instance owns discovery. */ } }
  }
  private atomic(path: string, value: unknown) { const tmp = path + '.tmp'; writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, path); }
  private save(row: Command) { row.updatedAt = new Date().toISOString(); this.atomic(join(this.commandsPath, row.requestId + '.json'), row); }
  private public(row: Command) { const { body: _body, fingerprint: _fingerprint, ...result } = row; return result; }
  private send(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) fail(403, '로컬 연결만 허용됩니다');
      if (req.headers.origin !== undefined) fail(403, '브라우저 Origin 요청은 허용되지 않습니다');
      const provided = Buffer.from(req.headers.authorization || ''), expected = Buffer.from('Bearer ' + this.secret);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) fail(401, '로컬 연결 인증이 필요합니다');
      const path = req.url || '';
      if (req.method === 'GET' && path === '/work') return this.send(res, 200, await this.target.list());
      let match = path.match(/^\/work\/([a-zA-Z0-9_-]{1,200})$/);
      if (req.method === 'GET' && match) return this.send(res, 200, await this.target.get(match[1]));
      match = path.match(/^\/commands\/([a-fA-F0-9-]{36})$/);
      if (req.method === 'GET' && match) { const row = this.commands.get(match[1].toLowerCase()); if (!row) fail(404, '명령을 찾을 수 없습니다'); return this.send(res, 200, this.public(row)); }
      if (req.method !== 'POST' || path !== '/commands') fail(404, '지원하지 않는 경로입니다');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > 65536) fail(413, '명령은 64KiB 이하여야 합니다'); chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
      let input: any; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'JSON 명령이 필요합니다'); }
      this.validate(input); input.requestId = input.requestId.toLowerCase();
      const fingerprint = createHash('sha256').update(canonical({ workId: input.workId, action: input.action, body: input.body })).digest('hex');
      const previous = this.commands.get(input.requestId);
      if (previous) { if (previous.fingerprint !== fingerprint) fail(409, '같은 명령 ID의 내용이 다릅니다'); return this.send(res, 202, this.public(previous)); }
      if (this.lifecycle.locked) fail(409, '앱 종료·업데이트 준비 중입니다');
      if (this.active.has(input.workId)) fail(409, '해당 업무의 원격 명령을 처리 중입니다. 기존 명령 상태를 조회해 주세요');
      const row: Command = { ...input, fingerprint, status: 'accepted', createdAt: new Date().toISOString(), updatedAt: '' };
      this.save(row); this.commands.set(row.requestId, row);
      const done = this.lifecycle.beginRequest('remote-mutation', row.workId); this.active.set(row.workId, row.requestId);
      this.send(res, 202, this.public(row));
      // The response only acknowledges durable acceptance. Keep the desktop lifecycle lease until the actual mutation ends.
      void this.run(row, done);
    } catch (error: any) { if (!res.headersSent) this.send(res, error.status || error.getStatus?.() || 500, { error: error.status || error.getStatus?.() ? error.message : '원격 연결 요청 처리에 실패했습니다' }); }
  }
  private validate(input: any) {
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !['requestId', 'workId', 'action', 'body'].includes(key)) || !uuid.test(input.requestId) || !identifier.test(input.workId) || !actions.includes(input.action) || !input.body || Array.isArray(input.body) || typeof input.body !== 'object') fail(400, '올바른 명령 ID, 업무 ID, 동작과 body가 필요합니다');
    const body = input.body;
    const allowed: Record<string,string[]> = { message: ['text'], answer: ['questionId','generation','answers'], approval: ['questionId','generation','decision'], interrupt: [], reconnect: [], 'recover-session': [], 'cancel-session-recovery': ['requestId'] };
    if (Object.keys(body).some(key => !allowed[input.action].includes(key))) fail(400, '지원하지 않는 명령 필드입니다');
    if (input.action === 'cancel-session-recovery' && !uuid.test(body.requestId || '')) fail(400, '중단할 원래 복구 requestId UUID가 필요합니다');
    if (input.action === 'message' && (typeof body.text !== 'string' || !body.text.trim())) fail(400, '메시지가 필요합니다');
    if (['answer','approval'].includes(input.action) && (typeof body.questionId !== 'string' || !/^[-a-zA-Z0-9_:]{1,300}$/.test(body.questionId) || typeof body.generation !== 'string' || !/^[-a-zA-Z0-9_]{1,200}$/.test(body.generation))) fail(400, '표시된 질문 ID와 generation이 필요합니다');
    if (input.action === 'answer' && (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers))) fail(400, '답변이 필요합니다');
    if (input.action === 'approval' && !['accept','decline'].includes(body.decision)) fail(400, '명시적인 승인 또는 거절이 필요합니다');
  }
  private async run(row: Command, done: () => void) {
    try { row.status = 'running'; this.save(row); row.result = await this.target.execute(row.action, row.workId, { ...row.body, ...(row.action === 'recover-session' ? { requestId: row.requestId } : {}) }); row.status = 'completed'; this.save(row); }
    catch (error: any) { row.status = 'failed'; row.errorStatus = error.getStatus?.() || error.status || 500; row.error = (row.errorStatus ?? 500) < 500 ? error.message : '명령 처리에 실패했습니다. 업무 상태를 확인해 주세요.'; try { this.save(row); } catch { row.status = 'uncertain'; } }
    finally { this.active.delete(row.workId); done(); }
  }
}
