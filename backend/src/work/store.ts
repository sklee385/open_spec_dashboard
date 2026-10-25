import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Subject } from 'rxjs';
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
  onApplicationShutdown() { this.updates.complete(); this.db.close(); }
}
