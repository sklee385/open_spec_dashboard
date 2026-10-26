import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { runtimeEnvironment, localRuntimeDirectory } from '../runtime';

export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private initializing?: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly requests = new Map<string | number, any>();
  generation = Math.random().toString(36).slice(2);
  private stopping = false;
  async ready() {
    if (!this.initializing) this.initializing = this.initialize().catch(error => { this.child?.kill(); this.child = undefined; this.initializing = undefined; throw error; });
    return this.initializing;
  }
  private async initialize() {
    this.generation = Math.random().toString(36).slice(2);
    const generation = this.generation;
    const env = runtimeEnvironment();
    const args = process.env.CODEX_ARGS ? JSON.parse(process.env.CODEX_ARGS) : ['app-server', ...(localRuntimeDirectory() ? ['-c', `shell_environment_policy.set.PATH=${JSON.stringify(env.PATH)}`] : [])];
    this.child = spawn(process.env.CODEX_BIN || 'codex', args, { stdio: 'pipe', windowsHide: true, shell: false, env });
    createInterface({ input: this.child.stdout }).on('line', line => {
      if (this.generation !== generation) return;
      let message: any;
      try { message = JSON.parse(line); } catch { this.emit('diagnostic', 'Codex가 JSON이 아닌 출력을 보냈습니다'); return; }
      if (!message.method && message.id !== undefined) {
        const request = this.pending.get(message.id); if (!request) return;
        clearTimeout(request.timer); this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
      } else {
        if (message.id !== undefined) this.requests.set(message.id, message);
        this.emit('notification', { ...message, generation });
      }
    });
    this.child.stderr.on('data', () => { /* stderr may contain account paths; do not persist credentials or raw logs */ });
    const fail = (error: Error) => {
      if (this.generation !== generation) return;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear(); this.requests.clear(); this.initializing = undefined;
      if (!this.stopping) this.emit('disconnected', error.message);
    };
    this.child.on('error', fail); this.child.on('exit', code => fail(new Error(`Codex 프로세스가 종료되었습니다 (${code})`)));
    await this.rpc('initialize', { clientInfo: { name: 'open_spec_dashboard', title: 'OpenSpec 업무 공간', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized', params: {} });
  }
  private write(value: unknown) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex 연결이 없습니다');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  rpc(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex 요청 결과를 확인할 수 없습니다: ${method}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id: string | number, result: unknown) {
    if (!this.requests.has(id)) throw new Error('종료되었거나 만료된 요청입니다');
    this.write({ id, result }); this.requests.delete(id);
  }
  async close() {
    this.stopping = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('서버 종료')); }
    this.pending.clear(); this.requests.clear();
    const child = this.child;
    if (child && child.exitCode === null) {
      await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 2000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin.end(); });
    }
  }
}
