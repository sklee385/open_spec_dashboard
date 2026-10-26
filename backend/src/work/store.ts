import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Subject } from 'rxjs';
import { createHash } from 'node:crypto';
import type { ToolConfig, ToolCapabilities } from '../ai-tools/config.service';

export interface Work {
  id: string; sourceId: string; projectPath: string; changeName: string; requestKey: string;
  ideaIds: string[]; phase: string; state: string; threadId: string | null;
  reviewedVersion: string | null; createdAt: string; updatedAt: string;
  toolId?: string; toolConfigSnapshot?: ToolConfig; toolCapabilities?: ToolCapabilities; providerSessionId?: string | null;
  error?: string; turnId?: string; [key: string]: unknown;
}
@Injectable()
export class WorkStore implements OnApplicationShutdown {
  readonly updates = new Subject<{ workId: string }>();
  readonly db: DatabaseSync;
  constructor() {
    const dir = resolve(process.env.DATA_DIR || '../.data'); mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'work.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS work (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, source_id TEXT NOT NULL, change_name TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(source_id,change_name));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL REFERENCES work(id), type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work(id), kind TEXT NOT NULL, data TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  list(): Work[] { return (this.db.prepare('SELECT data FROM work ORDER BY rowid DESC').all() as any[]).map(x => JSON.parse(x.data)); }
  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string): Work | undefined { const row: any = this.db.prepare('SELECT data FROM work WHERE id=?').get(id); return row ? JSON.parse(row.data) : undefined; }
  save(work: Work) {
    work.updatedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO work(id,request_key,source_id,change_name,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(work.id, work.requestKey, work.sourceId, work.changeName, JSON.stringify(work));
    return work;
  }
  event(id: string, type: string, data: unknown) {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(work_id,type,data,created_at) VALUES(?,?,?,?)').run(id, type, JSON.stringify(data), createdAt);
    this.updates.next({ workId: id });
    return { seq: Number(result.lastInsertRowid), workId: id, type, data, createdAt };
  }
  events(id: string, after = 0) { return (this.db.prepare('SELECT * FROM events WHERE work_id=? AND seq>? ORDER BY seq').all(id, after) as any[]).map(x => ({ seq: x.seq, workId: x.work_id, type: x.type, data: JSON.parse(x.data), createdAt: x.created_at })); }
  record(id: string, workId: string, kind: string, data: unknown) { this.db.prepare('INSERT INTO records(id,work_id,kind,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, workId, kind, JSON.stringify(data)); }
  records(workId: string, kind: string) { return (this.db.prepare('SELECT id,data FROM records WHERE work_id=? AND kind=? ORDER BY rowid').all(workId, kind) as any[]).map(x => ({ ...JSON.parse(x.data), id: x.id })); }
  attention(): AttentionItem[] {
    return this.db.prepare(`SELECT w.id AS workId, w.source_id AS sourceId, w.change_name AS changeName,
      COALESCE((SELECT json_extract(e.data, '$.title') FROM events e WHERE e.work_id=w.id AND e.type='source-idea' ORDER BY e.seq LIMIT 1), w.change_name) AS title,
      r.id AS questionId, json_extract(r.data, '$.kind') AS kind, 'pending' AS status,
      COALESCE(json_extract(r.data, '$.createdAt'), json_extract(w.data, '$.createdAt')) AS createdAt
      FROM records r JOIN work w ON w.id=r.work_id
      WHERE r.kind='question' AND json_extract(r.data, '$.status')='pending'
        AND json_extract(r.data, '$.kind') IN ('input','approval')
      ORDER BY createdAt DESC, r.id, w.id`).all() as unknown as AttentionItem[];
  }
  private nativeId(item: { workId: string; questionId: string }) { return `native-notification:${createHash('sha256').update(JSON.stringify([item.workId, item.questionId])).digest('hex')}`; }
  claimNative(item: AttentionItem): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO records(id,work_id,kind,data) VALUES(?,?,?,?)').run(this.nativeId(item), item.workId, 'native-notification', JSON.stringify({ questionId: item.questionId, state: 'claimed', updatedAt: new Date().toISOString() })).changes === 1;
  }
  finishNative(item: AttentionItem, state: 'submitted' | 'failed' | 'uncertain') {
    this.db.prepare("UPDATE records SET data=json_set(data,'$.state',?,'$.updatedAt',?) WHERE id=? AND kind='native-notification'").run(state, new Date().toISOString(), this.nativeId(item));
  }
  recoverNative() { this.db.prepare("UPDATE records SET data=json_set(data,'$.state','uncertain') WHERE kind='native-notification' AND json_extract(data,'$.state')='claimed'").run(); }
  nativeProblem(): string | null {
    const row = this.db.prepare(`SELECT 1 FROM records n JOIN records q ON q.id=json_extract(n.data,'$.questionId') AND q.work_id=n.work_id
      WHERE n.kind='native-notification' AND json_extract(n.data,'$.state') IN ('failed','uncertain') AND q.kind='question' AND json_extract(q.data,'$.status')='pending' LIMIT 1`).get();
    return row ? 'delivery-error' : null;
  }
  onApplicationShutdown() { this.updates.complete(); this.db.close(); }
}

export interface AttentionItem {
  workId: string; sourceId: string; changeName: string; title: string;
  questionId: string; kind: 'input' | 'approval'; status: 'pending'; createdAt: string;
}
