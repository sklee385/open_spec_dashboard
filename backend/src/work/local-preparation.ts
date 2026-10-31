import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConflictException } from '@nestjs/common';
import type { Work, WorkStore } from './store';
import { inspectWorkspacePath, pathsOverlap } from './workspace-paths';
import { WorkspacePreparation, type PreparationOptions } from './workspace-preparation';
import { runtimeCommand, runtimeEnvironment } from '../runtime';
import { stopOwnedProcess } from '../browser/browser-process';
import { guardBrowserProcess, guardWorkerPath } from '../browser/browser-job';
export interface LocalPreparationCommand { id: string; stage: 'install' | 'build'; command: string; args: string[]; }
export interface LocalPreparationPolicy {
  version: number; projectId: string; planRevision: string; confirmed: boolean;
  runtime: 'node' | 'none'; dependencies: 'copy' | 'install' | 'none';
  paths: string[]; generatedPaths: string[]; commands: LocalPreparationCommand[];
}
interface RunContext { cwd: string; env: NodeJS.ProcessEnv; }
interface Options { run?: (command: LocalPreparationCommand, context: RunContext) => Promise<void>; capacity?: PreparationOptions; }
interface ResourceFile { path: string; hash: string; size: number; dev: number; ino: number; mode: number; }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const within = (root: string, path: string) => { const rel = relative(key(root), key(path)); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
const prohibited = new Set(['.git', '.data', '.logs', '.aws', '.codex', '.reference']);
export class LocalPreparation {
  private children = new Set<ChildProcess>();
  private closing = false;
  constructor(private store: WorkStore, private options: Options = {}) {}
  review(work: Work, policy: LocalPreparationPolicy) { return this.validate(work, policy); }
  private path(value: string) {
    if (typeof value !== 'string' || !value || isAbsolute(value) || /[\0\r\n:]/.test(value)) throw new ConflictException('준비 목록의 상대 경로를 확인해 주세요.');
    const path = value.replaceAll('\\', '/'), parts = path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || prohibited.has(part.toLowerCase())) || parts[0].toLowerCase() === 'openspec' || parts[0].toLowerCase() === '.tools' && parts[1]?.toLowerCase() !== 'node-runtime') throw new ConflictException('보호 영역 또는 허용하지 않은 준비 목록입니다.');
    return path;
  }
  private validate(work: Work, value: LocalPreparationPolicy): LocalPreparationPolicy {
    if (!value || value.confirmed !== true) throw new ConflictException('프로젝트의 로컬 준비 목록과 명령을 먼저 확인해 주세요.');
    if (!work.workspace || !work.executionPath || work.workspace.status !== 'preparing' || !work.workspace.workspaceBaselineCommit || value.projectId !== work.workspace.projectId || value.planRevision !== work.workspace.sourcePlanRevision || !Number.isSafeInteger(value.version) || value.version < 1 || !['node', 'none'].includes(value.runtime) || !['copy', 'install', 'none'].includes(value.dependencies) || !Array.isArray(value.paths) || !Array.isArray(value.generatedPaths) || !Array.isArray(value.commands) || value.paths.length > 100 || value.generatedPaths.length > 100 || value.commands.length > 20) throw new ConflictException('프로젝트·계획 또는 준비 정책이 일치하지 않습니다.');
    const paths = value.paths.map(path => this.path(path)), generatedPaths = value.generatedPaths.map(path => this.path(path));
    for (let index = 0; index < paths.length; index++) if (paths.slice(0, index).some(other => pathsOverlap(join(work.projectPath, paths[index]), join(work.projectPath, other)))) throw new ConflictException('겹치는 준비 목록은 하나로 지정해 주세요.');
    const commands = value.commands.map(command => {
      if (!command || !/^[a-z0-9-]{1,80}$/.test(command.id) || !['install', 'build'].includes(command.stage) || typeof command.command !== 'string' || !command.command || /[\0\r\n]/.test(command.command) || !Array.isArray(command.args) || command.args.length > 100 || command.args.some(arg => typeof arg !== 'string' || /[\0]/.test(arg))) throw new ConflictException('검토할 준비 명령을 확인해 주세요.');
      if (/^(node|npm|npx)(\.exe|\.cmd)?$/i.test(command.command) && value.runtime !== 'node') throw new ConflictException('독립 Node 런타임 준비가 필요합니다.');
      return { id: command.id, stage: command.stage, command: command.command, args: [...command.args] };
    });
    if (new Set(commands.map(command => command.id)).size !== commands.length || value.dependencies === 'install' && !commands.some(command => command.stage === 'install')) throw new ConflictException('의존성 설치 명령과 중복 ID를 확인해 주세요.');
    return { version: value.version, projectId: value.projectId, planRevision: value.planRevision, confirmed: true, runtime: value.runtime, dependencies: value.dependencies, paths, generatedPaths, commands };
  }
  private async resources(source: string, paths: string[]) {
    const files: ResourceFile[] = [], directories: string[] = []; let count = 0;
    const protectedPaths = [process.env.DATA_DIR, process.env.CONFIG_PATH, process.env.OPENSPEC_UI_CONFIG].filter((path): path is string => !!path).map(path => resolve(path));
    const walk = async (path: string) => {
      if (++count > 250000) throw new Error('로컬 준비 파일 수 한도를 초과했습니다.');
      const name = relative(source, path).split(sep).join('/'); this.path(name);
      if (protectedPaths.some(protectedPath => pathsOverlap(path, protectedPath))) throw new Error('운영 데이터·설정은 로컬 준비로 복사할 수 없습니다.');
      const before = await fs.lstat(path);
      if (before.isSymbolicLink()) throw new Error('링크로 공유된 로컬 준비 파일은 사용할 수 없습니다.');
      if (before.isDirectory()) { inspectWorkspacePath(path, []); directories.push(name); for (const child of (await fs.readdir(path)).sort()) await walk(join(path, child)); return; }
      if (!before.isFile() || before.nlink !== 1) throw new Error('공유 hardlink 또는 일반 파일이 아닌 준비 항목입니다.');
      inspectWorkspacePath(dirname(path), []);
      const descriptor = await fs.open(path, 'r'); let content: Buffer;
      try { const opened = await descriptor.stat(); if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) throw new Error('준비 파일 소유가 변경되었습니다.'); content = await descriptor.readFile(); }
      finally { await descriptor.close(); }
      const after = await fs.lstat(path); if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1 || after.isSymbolicLink()) throw new Error('준비 파일이 읽는 중 변경되었습니다.');
      files.push({ path: name, hash: digest(content), size: content.length, dev: before.dev, ino: before.ino, mode: before.mode });
    };
    for (const path of paths) await walk(join(source, path));
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); directories.sort();
    return { files, directories, fingerprint: digest(JSON.stringify({ files, directories })) };
  }
  private async independent(root: string, project = true) {
    let count = 0;
    const visit = async (path: string) => {
      if (++count > 250000) throw new Error('준비 결과 파일 수 한도를 초과했습니다.');
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink()) { const real = await fs.realpath(path); if (process.platform === 'win32' || !within(root, real)) throw new Error('외부 링크 또는 junction으로 공유된 준비 결과입니다.'); return; }
      if (stat.isDirectory()) { for (const name of await fs.readdir(path)) { if (project && path === root && name === '.git') continue; if (prohibited.has(name.toLowerCase())) throw new Error('보호 자료가 준비 결과에 포함됐습니다.'); await visit(join(path, name)); } }
      else if (!stat.isFile() || stat.nlink !== 1) throw new Error('hardlink로 공유된 준비 결과입니다.');
    };
    await visit(root);
  }
  private async ownedData(work: Work) {
    const path = join(dirname(work.executionPath!), 'runtime-data'); inspectWorkspacePath(path, [work.projectPath, resolve(process.env.DATA_DIR || '../.data')]);
    const identityPath = join(path, 'identity.json'), stat = await fs.lstat(identityPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error('로컬 데이터 소유를 확인할 수 없습니다.');
    const identity = JSON.parse(await fs.readFile(identityPath, 'utf8'));
    if (identity.schemaVersion !== 1 || identity.workId !== work.id || identity.workspaceId !== work.workspace!.workspaceId) throw new Error('로컬 데이터 소유가 다릅니다.');
    await this.independent(path, false); return path;
  }
  async prepare(work: Work, input: LocalPreparationPolicy) {
    if (this.closing) throw new ConflictException('로컬 준비를 종료 중입니다.');
    const policy = this.validate(work, input), root = work.executionPath!, space = work.workspace!, policyDigest = digest(JSON.stringify(policy));
    const existing = this.store.records(work.id, 'workspace-local-preparation')[0];
    if (existing) {
      if (existing.status === 'ready' && existing.policyDigest === policyDigest) {
        await this.independent(root); await this.ownedData(work);
        const snapshot = this.store.records(work.id, 'workspace-local-private')[0];
        if (!snapshot || snapshot.fingerprint !== (await this.resources(root, policy.paths)).fingerprint) throw new ConflictException('준비한 로컬 자료가 변경되었습니다. 복구·재확인이 필요합니다.');
        return existing;
      }
      throw new ConflictException('기존 로컬 준비 상태를 먼저 복구해 주세요. 자동 재실행하지 않습니다.');
    }
    inspectWorkspacePath(root, [work.projectPath]);
    const id = `${work.id}:local-preparation`, data = { projectId: policy.projectId, workspaceId: space.workspaceId, rootId: space.rootId, executionPath: root, policyVersion: policy.version, policyDigest, planRevision: policy.planRevision, paths: policy.paths, generatedPaths: policy.generatedPaths, commands: policy.commands.map(command => ({ id: command.id, stage: command.stage })), status: 'preparing', startedAt: new Date().toISOString() };
    this.store.record(`${work.id}:local-policy`, work.id, 'workspace-local-policy', { ...policy, policyDigest, reviewedAt: new Date().toISOString() }); this.store.record(id, work.id, 'workspace-local-preparation', data);
    const guard = new WorkspacePreparation(this.store, this.options.capacity);
    try {
      let copiedFiles = 0, copiedBytes = 0;
      await guard.run(work, root, 'copy', async () => {
        const before = await this.resources(work.projectPath, policy.paths);
        for (const path of before.directories) { inspectWorkspacePath(join(root, path), [work.projectPath]); await fs.mkdir(join(root, path), { recursive: true }); }
        for (const file of before.files) {
          const source = join(work.projectPath, file.path), target = join(root, file.path); inspectWorkspacePath(dirname(target), [work.projectPath]); await fs.mkdir(dirname(target), { recursive: true }); inspectWorkspacePath(dirname(target), [work.projectPath]);
          const sourceFile = await fs.open(source, 'r'); let content: Buffer;
          try { const stat = await sourceFile.stat(); if (stat.dev !== file.dev || stat.ino !== file.ino || stat.nlink !== 1) throw new Error('복사 전 준비 파일 소유가 변경되었습니다.'); content = await sourceFile.readFile(); if (digest(content) !== file.hash) throw new Error('복사 전 준비 파일이 변경되었습니다.'); }
          finally { await sourceFile.close(); }
          const targetStat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
          if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1)) throw new Error('준비 대상 파일의 소유를 확인할 수 없습니다.');
          const output = await fs.open(target, targetStat ? 'r+' : 'wx');
          try { const stat = await output.stat(); if (stat.nlink !== 1 || targetStat && (stat.dev !== targetStat.dev || stat.ino !== targetStat.ino)) throw new Error('쓰기 전 준비 파일 소유가 변경되었습니다.'); await output.truncate(0); await output.writeFile(content); await output.chmod(file.mode & 0o777); }
          finally { await output.close(); }
          copiedFiles++; copiedBytes += file.size;
        }
        if ((await this.resources(work.projectPath, policy.paths)).fingerprint !== before.fingerprint) throw new Error('복사 중 원본 준비 파일이 변경되었습니다.');
        await this.independent(root);
      });
      const privateData = join(dirname(root), 'runtime-data');
      inspectWorkspacePath(privateData, [work.projectPath, resolve(process.env.DATA_DIR || '../.data')]);
      await fs.mkdir(privateData); // Never adopt a pre-existing data folder or junction.
      await fs.writeFile(join(privateData, 'identity.json'), JSON.stringify({ schemaVersion: 1, workId: work.id, workspaceId: space.workspaceId }), { flag: 'wx' });
      for (const path of ['tmp', 'home', 'npm-cache']) await fs.mkdir(join(privateData, path));
      const runtime = policy.runtime === 'node' ? join(root, '.tools', 'node-runtime') : undefined;
      if (runtime) { const stat = await fs.lstat(join(runtime, process.platform === 'win32' ? 'node.exe' : 'node')); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('독립 Node 런타임이 없습니다.'); }
      const env: NodeJS.ProcessEnv = {};
      for (const name of Object.keys(process.env)) if (/^(path|systemroot|windir|comspec|pathext|number_of_processors|processor_architecture)$/i.test(name)) env[name] = process.env[name];
      Object.assign(env, { DATA_DIR: privateData, CONFIG_PATH: join(privateData, 'config.local.json'), TEMP: join(privateData, 'tmp'), TMP: join(privateData, 'tmp'), HOME: join(privateData, 'home'), USERPROFILE: join(privateData, 'home'), npm_config_cache: join(privateData, 'npm-cache'), PORT: '0', SESSION_PORT: '0' });
      for (const command of policy.commands) await guard.run(work, root, command.stage, async () => {
        const executable = runtimeCommand(command.command, command.args, runtime), resolved = { ...command, ...executable };
        try { if (this.options.run) await this.options.run(resolved, { cwd: root, env: runtimeEnvironment(env, runtime) }); else await this.execute(work, resolved, { cwd: root, env: runtimeEnvironment(env, runtime) }); }
        catch { throw new Error(`로컬 준비 명령 ${command.id} 실행에 실패했습니다. 출력과 비밀값은 기록하지 않습니다.`); }
        await this.independent(root);
        await this.ownedData(work);
      });
      const snapshot = await this.resources(root, policy.paths);
      this.store.record(`${work.id}:local-private`, work.id, 'workspace-local-private', { policyDigest, fingerprint: snapshot.fingerprint });
      space.preparationPolicyVersion = policy.version; space.preparationPolicyDigest = policyDigest; space.localOnlyPaths = [...policy.paths, ...policy.generatedPaths]; this.store.save(work);
      this.store.record(id, work.id, 'workspace-local-preparation', { ...data, status: 'ready', copiedFiles, copiedBytes, endedAt: new Date().toISOString() }); return this.store.records(work.id, 'workspace-local-preparation')[0];
    } catch (error: any) {
      const message = error instanceof Error ? error.message : '로컬 준비에 실패했습니다.';
      space.status = 'failed'; space.error = message; work.state = 'failed'; work.error = message; work.errorCode = 'workspace-preparation-failed'; this.store.save(work); this.store.record(id, work.id, 'workspace-local-preparation', { ...data, status: 'failed', error: message, endedAt: new Date().toISOString() }); throw new ConflictException(message);
    }
  }
  private execute(work: Work, command: LocalPreparationCommand, context: RunContext) {
    return new Promise<void>((resolve, reject) => {
      // No project code runs before the supervisor has assigned this waiting
      // worker to its kill-on-close Job Object. Descendants inherit the job.
      const worker = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{try{const c=JSON.parse(input);const p=require('child_process').spawn(c.command,c.args,{cwd:process.cwd(),env:process.env,shell:false,windowsHide:true,stdio:'ignore'});p.once('error',()=>process.exit(1));p.once('close',code=>process.exit(code===0?0:1));}catch{process.exit(1)}});";
      const child = spawn(process.execPath, ['--require', guardWorkerPath(), '-e', worker], { ...context, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'ignore', 'ipc'] }); this.children.add(child);
      const guard = guardBrowserProcess(child); void guard.catch(() => {});
      const id = `${work.id}:local-process:${command.id}`, record = { commandId: command.id, stage: command.stage, workspaceId: work.workspace!.workspaceId, executionPath: context.cwd, pid: child.pid ?? null, status: 'running', startedAt: new Date().toISOString() };
      let done = false, timedOut = false;
      const finish = async (success: boolean) => {
        if (done) return; done = true; clearTimeout(timer);
        let cleaned = false;
        try { await (await guard).done; cleaned = true; } catch { /* Fail closed and preserve uncertain ownership. */ }
        const uncertain = !!child.pid && (!cleaned || child.exitCode === null && child.signalCode === null);
        if (!uncertain) this.children.delete(child);
        try { this.store.record(id, work.id, 'workspace-local-process', { ...record, status: uncertain ? 'uncertain' : success ? 'passed' : 'failed', endedAt: new Date().toISOString() }); } catch { success = false; }
        success && !uncertain ? resolve() : reject(new Error('로컬 준비 명령 실패'));
      };
      const timer = setTimeout(() => { timedOut = true; void stopOwnedProcess(child).then(() => finish(false), () => finish(false)); }, 600000);
      child.once('error', () => finish(false)); child.once('close', code => finish(code === 0 && !timedOut && !this.closing));
      child.stdin!.on('error', () => { void stopOwnedProcess(child).then(() => finish(false), () => finish(false)); });
      try {
        this.store.record(id, work.id, 'workspace-local-process', record);
        void guard.then(() => {
          if (this.closing || done) { void stopOwnedProcess(child).then(() => finish(false), () => finish(false)); return; }
          child.stdin!.end(JSON.stringify({ command: command.command, args: command.args }), (error?: Error | null) => { if (error) void stopOwnedProcess(child).then(() => finish(false), () => finish(false)); });
        }).catch(() => { void stopOwnedProcess(child).then(() => finish(false), () => finish(false)); });
      } catch { void stopOwnedProcess(child).then(() => finish(false), () => finish(false)); }
    });
  }
  async close() { this.closing = true; return Promise.allSettled([...this.children].map(child => stopOwnedProcess(child))); }
}
