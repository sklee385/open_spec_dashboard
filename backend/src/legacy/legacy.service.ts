import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { Subject, debounceTime, map, merge, interval, Observable } from 'rxjs';
import { watch, FSWatcher } from 'chokidar';
import { atomicWrite, textFile, within } from '../files';
import { changeAt, changeDetail, directories, markdownFiles, parseIdea } from './parser';
import type { WorkspaceSettings } from '../work/workspace-settings.service';

export interface SourceConfig { name: string; path: string; }
export interface ApplicationConfig { sources: SourceConfig[]; port: number; workspaces?: WorkspaceSettings; [key: string]: unknown; }
@Injectable()
export class LegacyService implements OnModuleDestroy, OnModuleInit {
  readonly updates = new Subject<void>();
  readonly configPath = resolve(process.env.CONFIG_PATH || process.env.OPENSPEC_UI_CONFIG || '../config.local.json');
  private watcher?: FSWatcher;
  private readiness: Promise<void>;
  constructor() {
    if (!existsSync(this.configPath)) {
      mkdirSync(dirname(this.configPath), { recursive: true });
      const root = resolve(__dirname, '../../..');
      atomicWrite(this.configPath, JSON.stringify({ port: 13002, sources: process.env.DESKTOP_TOKEN ? [] : [{ name: 'open_spec_dashboard', path: join(root, 'openspec') }] }, null, 2));
    }
    this.readiness = this.restartWatcher();
  }
  async onModuleInit() { await this.readiness; }
  config(): ApplicationConfig { return JSON.parse(textFile(this.configPath)!); }
  /** Shared by every writer of configPath; read inside the cross-process lock. */
  updateConfig<T>(change: (config: ApplicationConfig) => T): T {
    // The database stores no settings. SQLite's OS lock is released on process exit.
    const lock = new DatabaseSync(`${this.configPath}.lock.sqlite`);
    try { lock.exec('BEGIN IMMEDIATE'); }
    catch (error: any) { lock.close(); if ([5, 6].includes(error.errcode)) throw new ConflictException('다른 프로세스가 설정을 저장 중입니다. 상태를 확인해 주세요.'); throw error; }
    try {
      const config = this.config(), result = change(config);
      atomicWrite(this.configPath, JSON.stringify(config, null, 2));
      return result;
    } finally { try { lock.exec('ROLLBACK'); } finally { lock.close(); } }
  }
  sources() {
    return this.config().sources.map(source => {
      const path = resolve(dirname(this.configPath), source.path);
      return { id: source.name, name: source.name, path, valid: existsSync(path) && statSync(path).isDirectory() };
    });
  }
  source(id?: string | null, badRequest = false) {
    const source = this.sources().find(s => s.valid && (!id || s.id === id));
    if (!source) throw badRequest ? new BadRequestException('Source not found') : new NotFoundException('Source not found');
    return source;
  }
  splitId(id: string): [string, string] {
    const pos = id.indexOf('/');
    if (pos < 1 || !id.slice(pos + 1) || id.includes('\\') || id.includes('\0') || id.split('/').some(x => x === '..' || x === '.')) throw new BadRequestException('Invalid ID format');
    return [id.slice(0, pos), id.slice(pos + 1)];
  }
  async updateSources(body: any) {
    if (!Array.isArray(body?.sources) || body.sources.some((s: any) => typeof s?.name !== 'string' || !s.name.trim() || /[/\\]/.test(s.name) || typeof s.path !== 'string')) throw new BadRequestException('Invalid sources');
    if (new Set(body.sources.map((s: any) => s.name)).size !== body.sources.length) throw new BadRequestException('Duplicate sources');
    const config = this.updateConfig(config => {
      config.sources = body.sources.filter((s: SourceConfig) => { const path = resolve(dirname(this.configPath), s.path); return existsSync(path) && statSync(path).isDirectory(); });
      return config;
    });
    await this.restartWatcher(); this.updates.next(); return config;
  }
  private async restartWatcher() {
    await this.watcher?.close();
    const paths = this.sources().filter(s => s.valid).map(s => s.path);
    if (!paths.length) { this.watcher = undefined; return; }
    this.watcher = watch(paths, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }, ignored: /(^|[/\\])\.[^/\\]+\.tmp$/ });
    this.watcher.on('all', () => this.updates.next());
    this.watcher.on('error', error => console.error('OpenSpec file watcher:', error));
    await new Promise<void>((resolveReady, reject) => { this.watcher!.once('ready', () => resolveReady()); this.watcher!.once('error', reject); });
  }
  events(): Observable<any> { return merge(this.updates.pipe(debounceTime(100), map(() => ({ type: 'update', data: '{}' }))), interval(15000).pipe(map(() => ({ type: 'heartbeat', data: '{}' })))); }
  async onModuleDestroy() { await this.watcher?.close(); this.updates.complete(); }
  ideas() {
    return this.sources().filter(s => s.valid).flatMap(s => {
      const dir = within(s.path, 'ideas');
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && !e.isSymbolicLink() && e.name.endsWith('.md')).map(e => parseIdea(textFile(within(s.path, `ideas/${e.name}`))!, s.id)).filter(x => x !== null);
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  validateIdea(body: any) {
    if (typeof body?.title !== 'string' || !body.title.trim() || /[\r\n]/.test(body.title) || body.title.length > 500 || typeof body.description !== 'string' || body.description.length > 1000000) throw new BadRequestException('Invalid idea');
  }
  saveIdea(body: any, id?: string) {
    this.validateIdea(body);
    const [sourceId, ideaId] = id ? this.splitId(id) : [body.sourceId, `idea-${Date.now()}-${randomUUID().slice(0, 8)}`];
    if (ideaId.includes('/')) throw new BadRequestException('Invalid idea ID format');
    const source = this.source(sourceId, !id);
    const path = within(source.path, `ideas/${ideaId}.md`);
    const previous = id ? this.ideas().find(x => x.id === id) : undefined;
    if (id && !previous) throw new NotFoundException('Idea not found');
    const now = new Date().toISOString();
    const meta = { id: ideaId, projectId: previous?.projectId ?? null, createdAt: previous?.createdAt ?? now, updatedAt: now };
    mkdirSync(dirname(path), { recursive: true });
    atomicWrite(path, `---\n${stringify(meta)}---\n\n# ${body.title}\n\n${body.description}\n`);
    this.updates.next(); return parseIdea(textFile(path)!, source.id);
  }
  deleteIdea(id: string) {
    const [sourceId, ideaId] = this.splitId(id);
    if (ideaId.includes('/')) throw new BadRequestException('Invalid idea ID format');
    const source = this.source(sourceId), path = within(source.path, `ideas/${ideaId}.md`);
    if (existsSync(path)) { const trash = within(source.path, '.idea-trash'); mkdirSync(trash, { recursive: true }); renameSync(path, join(trash, `${randomUUID()}-${ideaId}.md`)); }
    this.updates.next();
  }
  changes() {
    return this.sources().filter(s => s.valid).flatMap(source => [
      ...directories(join(source.path, 'changes')).filter(x => x !== 'archive').map(name => changeAt(source.path, source.id, name)),
      ...directories(join(source.path, 'changes', 'archive')).map(name => changeAt(source.path, source.id, name, true)),
    ].filter(x => x !== null));
  }
  detail(id: string) { const [sourceId, name] = this.splitId(id), source = this.source(sourceId); const detail = changeDetail(source.path, source.id, name); if (!detail) throw new NotFoundException('Change not found'); return detail; }
  specs() {
    return this.sources().filter(s => s.valid).flatMap(s => {
      const top = readdirSync(s.path, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.md') && !['proposal.md', 'tasks.md', 'design.md'].includes(e.name)).map(e => e.name);
      return [...top, ...markdownFiles(join(s.path, 'specs'))].map(path => ({ id: `${s.id}/${path.replace(/\/spec\.md$|\.md$/g, '')}`, sourceId: s.id, path }));
    });
  }
  spec(id: string) {
    const [sourceId, name] = this.splitId(id), source = this.source(sourceId);
    const spec = this.specs().find(x => x.id === id || x.id === `${sourceId}/${name.replace(/\/spec\.md$|\.md$/g, '')}`);
    if (!spec) throw new NotFoundException('Spec not found');
    const top = within(source.path, spec.path), path = existsSync(top) ? top : within(source.path, `specs/${spec.path}`);
    return { ...spec, content: textFile(path) };
  }
}
