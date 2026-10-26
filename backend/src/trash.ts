import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { atomicWrite } from './files';

export type TrashEntry = { id: string; kind: 'idea' | 'change'; title: string; deletedAt: string };
const active = new Set(['running', 'connecting', 'creating-thread', 'waiting-input', 'waiting-approval']);

/** Board deletion keeps source files and session history intact; only visibility metadata changes. */
export class BoardTrash {
  private readonly path: string;
  private entries: TrashEntry[];
  private busy = false;
  constructor(private readonly port: number, directory = process.env.DATA_DIR || '../.data', private readonly pendingCommands = () => 0, private readonly token?: string) {
    this.path = resolve(directory, 'board-trash.json');
    this.entries = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : [];
    if (!Array.isArray(this.entries)) throw new Error('Invalid board trash');
  }
  private async get(path: string) {
    const response = await fetch(`http://127.0.0.1:${this.port}/api/${path}`, { signal: AbortSignal.timeout(5000), headers: this.token ? { 'x-desktop-token': this.token } : undefined });
    if (!response.ok) throw new Error('업무 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    return response.json();
  }
  private save(next: TrashEntry[]) {
    mkdirSync(dirname(this.path), { recursive: true });
    atomicWrite(this.path, JSON.stringify(next, null, 2)); this.entries = next;
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    const trash = path === '/api/trash' || path === '/api/trash/restore';
    const mutation = req.method !== 'GET' && /^\/api\/(work|ideas)(\/|$)/.test(path);
    if (!trash && (!mutation || !this.entries.length)) return false;
    const reply = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); return true; };
    if (req.headers.origin) {
      try { if (!['127.0.0.1','localhost','[::1]'].includes(new URL(req.headers.origin).hostname)) return reply(403, { message: '허용되지 않은 Origin입니다' }); }
      catch { return reply(403, { message: '잘못된 Origin입니다' }); }
    }
    if (trash && req.method === 'GET' && path === '/api/trash') return reply(200, { entries: this.entries });
    if (trash && req.method !== 'POST') return reply(405, { message: '허용되지 않은 요청입니다' });
    try {
      if (!trash) {
        if (this.busy) return reply(409, { message: '삭제 상태를 저장 중입니다. 잠시 후 다시 시도해 주세요.' });
        if (path === '/api/work' && req.method === 'POST') {
          const chunks: Buffer[] = []; let length = 0;
          for await (const chunk of req) { length += chunk.length; if (length > 8000) return reply(400, { message: '요청이 너무 큽니다' }); chunks.push(Buffer.from(chunk)); }
          const body = Buffer.concat(chunks);
          let value: any;
          try { value = JSON.parse(body.toString('utf8')); } catch { return reply(400, { message: '잘못된 요청입니다' }); }
          if (this.entries.some(entry => entry.kind === 'change' ? entry.id === `${value.sourceId}/${value.changeName}` : entry.id === value.ideaId)) return reply(409, { message: '삭제된 항목입니다. 휴지통에서 복원한 뒤 진행해 주세요.' });
          (req as IncomingMessage & { boardBody?: Buffer }).boardBody = body;
        }
        const ideaId = /^\/api\/ideas\/(.+)$/.exec(path)?.[1];
        if (ideaId && this.entries.some(entry => entry.kind === 'idea' && entry.id === decodeURIComponent(ideaId))) return reply(409, { message: '삭제된 아이디어입니다. 휴지통에서 먼저 복원해 주세요.' });
        // Reject commands from stale tabs against a deleted work without touching its session.
        const workId = /^\/api\/work\/([^/]+)/.exec(path)?.[1];
        if (workId && !path.endsWith('/interrupt')) {
          const { work } = await this.get('work');
          const current = work.find((item: any) => item.id === decodeURIComponent(workId));
          if (current && this.entries.some(entry => entry.kind === 'change' && entry.id === `${current.sourceId}/${current.changeName}`)) return reply(409, { message: '삭제된 업무입니다. 휴지통에서 복원한 뒤 진행해 주세요.' });
        }
        return false;
      }
      if (this.busy) return reply(409, { message: '삭제 상태를 저장 중입니다. 다시 시도해 주세요.' });
      if (this.pendingCommands()) return reply(409, { message: '업무 요청을 처리 중입니다. 잠시 후 다시 시도해 주세요.' });
      this.busy = true;
      try {
        let text = '';
        for await (const chunk of req) { text += chunk; if (text.length > 8000) return reply(400, { message: '요청이 너무 큽니다' }); }
        let body: any;
        try { body = JSON.parse(text); } catch { return reply(400, { message: '잘못된 요청입니다' }); }
        if (!['idea','change'].includes(body?.kind) || typeof body.id !== 'string' || !body.id.includes('/')) return reply(400, { message: '항목을 확인해 주세요' });
        const same = (entry: TrashEntry) => entry.id === body.id && entry.kind === body.kind;
        if (path.endsWith('/restore')) {
          this.save(this.entries.filter(entry => !same(entry))); return reply(200, { restored: true });
        }
        if (this.entries.some(same)) return reply(200, { deleted: true });
        const data = await this.get(body.kind === 'idea' ? 'ideas' : 'changes');
        const item = data[body.kind === 'idea' ? 'ideas' : 'changes'].find((item: any) => item.id === body.id);
        if (!item) return reply(404, { message: '항목을 찾을 수 없습니다' });
        if (body.kind === 'change' && !['draft','todo','in_progress'].includes(item.status)) return reply(409, { message: '초안·할 일·진행 중인 업무만 삭제할 수 있습니다' });
        const { work } = await this.get('work');
        const related = work.filter((item: any) => body.kind === 'change' ? `${item.sourceId}/${item.changeName}` === body.id : item.ideaIds?.includes(body.id));
        if (related.some((item: any) => active.has(item.state))) return reply(409, { message: '실행·질문·승인 대기 중인 업무는 먼저 현재 실행을 중단한 뒤 삭제해 주세요.' });
        if (body.kind === 'idea' && related.length) return reply(409, { message: '업무로 전환된 아이디어입니다. 연결된 업무에서 삭제해 주세요.' });
        this.save([...this.entries, { id: body.id, kind: body.kind, title: item.title || item.name, deletedAt: new Date().toISOString() }]);
        return reply(200, { deleted: true });
      } finally { this.busy = false; }
    } catch { return reply(503, { message: '삭제 상태를 저장하거나 업무 상태를 확인하지 못했습니다. 기존 항목은 유지됩니다.' }); }
  }
}
