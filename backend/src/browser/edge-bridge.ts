import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

export type EdgeOperation = 'observe' | 'click' | 'fill' | 'scroll' | 'capture';
export type EdgeInput = { op: EdgeOperation; observationId?: string; elementId?: string; text?: string; direction?: 'up' | 'down'; pixels?: number };
type Observation = { observationId: string; url: string; title: string; text: string; elements: { id: string; role: string; label: string }[] };
type Command = { id: string; op: EdgeOperation; args: Omit<EdgeInput, 'op'>; tabId: number; expectedUrl: string; expiresAt: number };
type Connection = { workId: string; token: string; tabId: number; url: string; title: string; origin: string; lastSeen: number; observation?: Observation; pending?: {
  command: Command; delivered: boolean; resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
}; poll?: () => void };
class BridgeError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const fail = (status: number, message: string): never => { throw new BridgeError(status, message); };
const httpUrl = (value: unknown) => {
  if (typeof value !== 'string' || value.length > 4096) return fail(400, '탭 주소가 올바르지 않습니다');
  let url: URL; try { url = new URL(value); } catch { return fail(400, '탭 주소가 올바르지 않습니다'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fail(400, 'http/https 탭만 연결할 수 있습니다');
  return url;
};

/** The app's session owns this server. It never shares the desktop API token. */
export class EdgeBridge {
  private server?: Server;
  private starting?: Promise<string>;
  private codes = new Map<string, { workId: string; expires: number }>();
  private connections = new Map<string, Connection>();
  private closed = false;
  constructor(private readonly options: { commandTimeoutMs?: number; codeTtlMs?: number; connectionTtlMs?: number } = {}) {}
  private async listen() {
    if (this.closed) throw new Error('Edge 연결 서비스가 종료됐습니다');
    if (!this.starting) this.starting = new Promise<string>((resolve, reject) => {
      const server = this.server = createServer((req, res) => { void this.handle(req, res); });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('Edge 연결 주소를 확인하지 못했습니다'));
        resolve(`http://127.0.0.1:${address.port}`);
      });
    }).catch(error => { this.server?.close(); this.starting = undefined; throw error; });
    return this.starting;
  }
  async createPair(workId: string) {
    const endpoint = await this.listen();
    for (const [code, item] of this.codes) if (item.workId === workId || item.expires <= Date.now()) this.codes.delete(code);
    const code = randomBytes(12).toString('hex'), expires = Date.now() + (this.options.codeTtlMs ?? 120000);
    this.codes.set(code, { workId, expires });
    return { endpoint, code, expiresAt: new Date(expires).toISOString() };
  }
  private current(workId: string) {
    const connection = this.connections.get(workId);
    if (connection && Date.now() - connection.lastSeen > (this.options.connectionTtlMs ?? 60000)) { this.disconnect(workId); return undefined; }
    return connection;
  }
  status(workId: string) {
    const connection = this.current(workId);
    return connection ? { connected: true, tabId: connection.tabId, url: connection.url, title: connection.title } : { connected: false };
  }
  list() { return [...this.connections.keys()].flatMap(workId => { const status = this.status(workId); return status.connected ? [{ workId, ...status }] : []; }); }
  disconnect(workId: string) {
    for (const [code, item] of this.codes) if (item.workId === workId) this.codes.delete(code);
    const connection = this.connections.get(workId); this.connections.delete(workId);
    if (!connection) return;
    const pending = connection.pending; connection.pending = undefined; connection.observation = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Edge 연결이 해제됐습니다. 실행 결과가 불명확한 동작을 자동 반복하지 마세요.')); }
    connection.poll?.();
  }
  cancel(workId: string) {
    const connection = this.connections.get(workId), pending = connection?.pending;
    if (!connection || !pending) return;
    clearTimeout(pending.timer); connection.pending = undefined; connection.observation = undefined;
    pending.reject(new Error('Edge 요청이 취소됐습니다. 조작을 자동 반복하지 마세요.'));
  }
  async execute(workId: string, input: EdgeInput): Promise<any> {
    const connection = this.current(workId);
    if (!connection) throw new Error('Edge 탭을 먼저 연결해 주세요');
    if (connection.pending) throw new Error('이 탭에서 이전 요청을 처리 중입니다');
    if (!input || !['observe', 'click', 'fill', 'scroll', 'capture'].includes(input.op)) throw new Error('지원하지 않는 Edge 동작입니다');
    if (['click', 'fill', 'scroll'].includes(input.op)) {
      if (!connection.observation || input.observationId !== connection.observation.observationId) throw new Error('새 관찰이 필요합니다');
      if (['click', 'fill'].includes(input.op) && !connection.observation.elements.some(element => element.id === input.elementId)) throw new Error('관찰에 없는 요소입니다');
      if (input.op === 'fill' && (typeof input.text !== 'string' || input.text.length > 10000)) throw new Error('입력 내용은 10000자 이하여야 합니다');
      if (input.op === 'scroll' && (!['up', 'down'].includes(input.direction || '') || !Number.isInteger(input.pixels) || input.pixels! < 1 || input.pixels! > 2000)) throw new Error('스크롤 방향과 거리(1~2000)를 확인해 주세요');
    }
    const { op, ...args } = input;
    return new Promise((resolve, reject) => {
      const command: Command = { id: randomUUID(), op, args, tabId: connection.tabId, expectedUrl: connection.url, expiresAt: Date.now() + (this.options.commandTimeoutMs ?? 20000) };
      const timer = setTimeout(() => {
        if (connection.pending?.command.id !== command.id) return;
        connection.pending = undefined; connection.observation = undefined;
        reject(new Error('Edge 요청 시간이 초과됐습니다. 조작 결과를 새로 관찰하고 같은 입력을 자동 반복하지 마세요.'));
      }, this.options.commandTimeoutMs ?? 20000);
      connection.pending = { command, delivered: false, resolve, reject, timer };
      if (op !== 'observe' && op !== 'capture') connection.observation = undefined;
      connection.poll?.();
    });
  }
  private async body(req: IncomingMessage) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) fail(413, 'Edge 응답이 너무 큽니다'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(400, 'JSON 형식이 아닙니다'); }
  }
  private authenticate(req: IncomingMessage) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return fail(401, 'Edge 연결 인증이 필요합니다');
    const connection = [...this.connections.values()].find(item => item.token === header.slice(7));
    if (!connection || !this.current(connection.workId)) return fail(401, 'Edge 연결이 만료됐습니다');
    connection.lastSeen = Date.now(); return connection;
  }
  private validateResult(connection: Connection, command: Command, result: any) {
    const url = httpUrl(result?.url);
    if (url.origin !== connection.origin) { this.disconnect(connection.workId); return fail(409, '다른 사이트로 이동해 Edge 연결을 해제했습니다'); }
    connection.url = url.href;
    if (command.op === 'observe') {
      if (typeof result.observationId !== 'string' || !result.observationId || result.observationId.length > 100 || typeof result.text !== 'string' || result.text.length > 100000 || typeof result.title !== 'string' || result.title.length > 1000 || !Array.isArray(result.elements) || result.elements.length > 2000) return fail(400, '잘못된 Edge 관찰 결과입니다');
      if (result.elements.some((element: any) => !element || typeof element.id !== 'string' || element.id.length > 100 || typeof element.role !== 'string' || element.role.length > 100 || typeof element.label !== 'string' || element.label.length > 1000)) return fail(400, '잘못된 Edge 요소입니다');
      const observation: Observation = { observationId: result.observationId, url: url.href, title: result.title, text: result.text, elements: result.elements.map((element: any) => ({ id: element.id, role: element.role, label: element.label })) };
      connection.observation = observation; connection.title = result.title; return observation;
    }
    if (command.op === 'capture') {
      if (typeof result.image !== 'string' || result.image.length > 3 * 1024 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.image)) return fail(400, '잘못된 Edge 화면 이미지입니다');
      return { image: result.image, url: url.href };
    }
    return { url: url.href };
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, data: unknown) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); } };
    try {
      if (this.closed) return fail(503, 'Edge 연결 서비스가 종료됐습니다');
      const address = this.server?.address();
      if (!address || typeof address === 'string' || req.headers.host !== `127.0.0.1:${address.port}`) return fail(403, '허용되지 않은 연결 주소입니다');
      const origin = req.headers.origin;
      if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return fail(403, '웹 페이지의 직접 연결 요청은 허용하지 않습니다');
      if (req.method === 'POST' && req.url === '/pair') {
        const body = await this.body(req), pair = this.codes.get(body?.code);
        if (!pair || pair.expires <= Date.now()) return fail(401, '연결 코드가 잘못됐거나 만료됐습니다');
        const url = httpUrl(body.url);
        if (!Number.isInteger(body.tabId) || body.tabId < 0 || typeof body.title !== 'string' || body.title.length > 1000) return fail(400, '연결할 탭 정보가 올바르지 않습니다');
        this.codes.delete(body.code); this.disconnect(pair.workId);
        const token = randomBytes(32).toString('hex');
        this.connections.set(pair.workId, { workId: pair.workId, token, tabId: body.tabId, url: url.href, origin: url.origin, title: body.title, lastSeen: Date.now() });
        return send(200, { token, workId: pair.workId });
      }
      const connection = this.authenticate(req);
      if (req.method === 'DELETE' && req.url === '/connection') { this.disconnect(connection.workId); return send(200, { connected: false }); }
      if (req.method === 'GET' && /^\/commands\/[a-f0-9-]{36}$/.test(req.url || '')) {
        const pending = connection.pending;
        if (!pending || !pending.delivered || pending.command.id !== req.url!.slice('/commands/'.length) || pending.command.expiresAt <= Date.now()) return fail(409, '취소됐거나 만료된 Edge 요청입니다');
        return send(200, { valid: true });
      }
      if (req.method === 'GET' && req.url === '/commands') {
        if (connection.poll) return fail(409, '이미 Edge 요청을 기다리고 있습니다');
        await new Promise<void>(resolve => {
          let timer: NodeJS.Timeout;
          const finish = () => {
            clearTimeout(timer); res.off('close', finish); connection.poll = undefined;
            const pending = connection.pending;
            if (this.connections.get(connection.workId) !== connection) send(401, { error: 'Edge 연결이 해제됐습니다' });
            else if (pending && !pending.delivered) { pending.delivered = true; send(200, { command: pending.command }); }
            else send(200, { command: null });
            resolve();
          };
          timer = setTimeout(finish, 15000); connection.poll = finish; res.once('close', finish);
          if (connection.pending && !connection.pending.delivered) finish();
        }); return;
      }
      if (req.method === 'POST' && req.url === '/results') {
        const body = await this.body(req), pending = connection.pending;
        if (this.current(connection.workId) !== connection) return fail(401, 'Edge 연결이 해제됐습니다');
        if (!pending || body?.id !== pending.command.id || !pending.delivered) return fail(409, '이미 끝났거나 전달하지 않은 Edge 요청입니다');
        clearTimeout(pending.timer); connection.pending = undefined;
        if (body.ok !== true) { connection.observation = undefined; pending.reject(new Error(typeof body.error === 'string' ? body.error.slice(0, 1000) : 'Edge 요청을 수행하지 못했습니다')); }
        else try { pending.resolve(this.validateResult(connection, pending.command, body.result)); }
        catch (error) { connection.observation = undefined; pending.reject(error instanceof Error ? error : new Error('Edge 결과를 확인하지 못했습니다')); throw error; }
        return send(200, { accepted: true });
      }
      return fail(404, 'Edge 경로가 없습니다');
    } catch (error) { send(error instanceof BridgeError ? error.status : 500, { error: error instanceof Error ? error.message : 'Edge 연결 오류' }); }
  }
  async close() {
    this.closed = true; this.codes.clear();
    for (const workId of this.connections.keys()) this.disconnect(workId);
    if (this.server) { const server = this.server; await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  }
}
