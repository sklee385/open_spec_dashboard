import { BadRequestException, ConflictException, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LegacyService } from '../legacy/legacy.service';
import { Work, WorkStore } from './store';

export interface VerificationCommand { id: string; command: string; args: string[]; }
@Injectable()
export class ExecutionService implements OnModuleDestroy {
  private children = new Map<string, ChildProcess>();
  private closing = false;
  private interrupted = new Set<string>();
  constructor(@Inject(WorkStore) readonly store: WorkStore, @Inject(LegacyService) readonly legacy: LegacyService) {
    for (const work of store.list()) for (const record of store.records(work.id, 'verification').filter(x => x.status === 'running')) store.record(record.id, work.id, 'verification', { ...record, status: 'interrupted', error: '서버 재시작으로 검증 결과를 확인할 수 없습니다' });
  }
  snapshot(work: Work): Record<string, { hash: string; content: string | null }> {
    const files: Record<string, { hash: string; content: string | null }> = {};
    const excluded = new Set(['.git', '.data', '.reference', '.tools', '.logs', '.idea-trash', 'node_modules', 'dist', '.nuxt', '.output']);
    const dataDir = resolve(process.env.DATA_DIR || '../.data');
    const visit = (dir: string, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const absolute = join(dir, entry.name), path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || excluded.has(entry.name) || absolute === dataDir || entry.name.endsWith('.tsbuildinfo')) continue;
        if (entry.isDirectory()) { visit(absolute, path); continue; }
        if (!entry.isFile()) continue;
        const bytes = readFileSync(absolute), content = bytes.length < 200000 && !bytes.includes(0) ? bytes.toString('utf8') : null;
        const normalized = path.endsWith('/tasks.md') && content ? content.replace(/- \[[xX ]\]/g, '- [ ]') : bytes;
        files[path] = { hash: createHash('sha256').update(normalized).digest('hex'), content };
      }
    };
    visit(work.projectPath); return files;
  }
  revision(work: Work) { return createHash('sha256').update(JSON.stringify(Object.entries(this.snapshot(work)).map(([path, value]) => [path, value.hash]).sort())).digest('hex'); }
  baseline(work: Work) {
    if (this.store.records(work.id, 'baseline').length) return;
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: work.projectPath, shell: false, windowsHide: true, encoding: 'utf8', timeout: 2000 });
    const gitHead = result.status === 0 ? result.stdout.trim() : null;
    this.store.record(`${work.id}:baseline`, work.id, 'baseline', { files: this.snapshot(work), gitHead });
  }
  changes(work: Work) {
    const previous = this.store.records(work.id, 'baseline')[0]?.files || {}, current = this.snapshot(work);
    return [...new Set([...Object.keys(previous), ...Object.keys(current)])].filter(path => previous[path]?.hash !== current[path]?.hash).map(path => ({ path, before: previous[path]?.content ?? null, after: current[path]?.content ?? null, status: !previous[path] ? 'added' : !current[path] ? 'removed' : 'modified' }));
  }
  commands(work: Work): VerificationCommand[] {
    if (Array.isArray(work.verificationCommands)) return work.verificationCommands as VerificationCommand[];
    const pkg = join(work.projectPath, 'package.json');
    if (!existsSync(pkg)) return [];
    const scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts || {};
    return [scripts['test:run'] ? 'test:run' : 'test', 'typecheck', 'build', 'lint'].filter(id => scripts[id]).map(id => ({ id, command: process.env.NPM_BIN || 'npm', args: ['run', id] }));
  }
  setCommands(work: Work, body: any) {
    if (this.children.has(work.id) || !['idle', 'interrupted', 'failed'].includes(work.state) || ['completed', 'archived'].includes(work.phase)) throw new ConflictException('현재 상태에서는 검증 계획을 바꿀 수 없습니다');
    if (!Array.isArray(body?.commands) || !body.commands.length || body.commands.some((c: any) => !c || typeof c.id !== 'string' || !/^[a-zA-Z0-9:_-]+$/.test(c.id) || typeof c.command !== 'string' || !c.command.trim() || !Array.isArray(c.args) || c.args.some((arg: any) => typeof arg !== 'string'))) throw new BadRequestException('검증은 ID, 실행 파일, 인자 배열이 필요합니다');
    if (new Set(body.commands.map((c: any) => c.id)).size !== body.commands.length) throw new BadRequestException('중복된 검증 ID입니다');
    work.verificationCommands = body.commands; this.store.save(work); return this.commands(work);
  }
  results(work: Work) {
    const revision = this.revision(work), commands = this.commands(work);
    return this.store.records(work.id, 'verification').map(record => ({ ...record, fresh: record.revision === revision && record.commandVersion === JSON.stringify(commands.find(x => x.id === record.commandId)) }));
  }
  run(work: Work, commandId: string) {
    if (this.children.has(work.id) || !['idle', 'interrupted', 'failed'].includes(work.state) || ['completed', 'archived'].includes(work.phase)) throw new ConflictException('업무의 다른 실행이 진행 중이거나 완료되었습니다');
    const command = this.commands(work).find(c => c.id === commandId); if (!command) throw new BadRequestException('등록된 검증 명령이 아닙니다');
    const record = { id: randomUUID(), commandId, commandVersion: JSON.stringify(command), revision: this.revision(work), status: 'running', stdout: '', stderr: '', code: null as number | null, createdAt: new Date().toISOString() };
    this.store.record(record.id, work.id, 'verification', record); work.phase = 'verification'; work.state = 'running'; this.store.save(work);
    const child = spawn(command.command, command.args, { cwd: work.projectPath, shell: false, windowsHide: true }); this.children.set(work.id, child);
    const timer = setTimeout(() => child.kill(), 600000);
    let finished = false;
    const finish = (code: number | null, error?: string) => {
      if (finished) return; finished = true; clearTimeout(timer); this.children.delete(work.id);
      if (this.closing) return;
      record.code = code; record.status = this.interrupted.delete(work.id) ? 'interrupted' : code === 0 && !error ? 'passed' : 'failed'; if (error) record.stderr += error;
      this.store.record(record.id, work.id, 'verification', record); const latest = this.store.get(work.id)!; latest.state = 'idle'; this.store.save(latest);
      this.store.event(work.id, 'verification', record); this.legacy.updates.next();
    };
    child.stdout?.on('data', chunk => { record.stdout += chunk; if (record.stdout.length > 2000000) child.kill(); });
    child.stderr?.on('data', chunk => { record.stderr += chunk; if (record.stderr.length > 2000000) child.kill(); });
    child.once('error', error => finish(null, error.message)); child.once('close', code => finish(code)); return record;
  }
  interrupt(id: string) {
    const child = this.children.get(id); if (!child) return false;
    this.interrupted.add(id); child.kill(); return true;
  }
  onModuleDestroy() { this.closing = true; for (const child of this.children.values()) child.kill(); this.children.clear(); }
}
