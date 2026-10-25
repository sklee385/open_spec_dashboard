import { BadRequestException, ConflictException, Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Work, WorkStore } from '../work/store';
import { LegacyService } from '../legacy/legacy.service';
import { markdownFiles } from '../legacy/parser';
import { textFile, within } from '../files';
import { reviewInstructions } from '../review/instructions';
import { readiness, ToolConfig } from './config.service';
import { windowsProcessTreeScript } from './windows-process-tree';

type Running = { child: ChildProcess; stopped?: string; kill?: Promise<boolean>; done: Promise<void> };
const diagnostics: Record<string, string> = {
  'missing-executable': '실행 파일이 없습니다. 설치·실행 경로를 확인해 주세요.',
  'authentication-failed': '인증에 실패했습니다. CLI에서 직접 인증한 뒤 다시 요청해 주세요.',
  'execution-failed': '외부 CLI 실행에 실패했습니다. 비대화형 입력 설정과 CLI 실행 환경을 확인해 주세요.',
  timeout: '요청 제한 시간을 초과하여 중단했습니다.', 'output-limit': '출력 2MiB 제한을 초과하여 중단했습니다.',
  interrupted: '사용자 요청으로 중단했습니다.', 'termination-unconfirmed': '프로세스 트리 종료를 확인하지 못했습니다. 외부 프로세스를 확인해 주세요.',
  'argument-limit': '운영체제의 인자 길이 제한을 초과했습니다. stdin 입력 방식으로 변경해 새 업무를 만들어 주세요.',
};
@Injectable()
export class ExternalCliAdapter implements OnModuleDestroy {
  private running = new Map<string, Running>();
  constructor(@Inject(WorkStore) private store: WorkStore, @Inject(LegacyService) private legacy: LegacyService) {
    for (const work of store.list().filter(w => w.toolId && w.toolId !== 'codex' && ['running', 'connecting', 'recovery-required'].includes(w.state))) {
      work.state = 'recovery-required'; work.errorCode = 'external-restarted'; work.error = '외부 실행 결과가 불명확합니다. 기록과 프로세스를 확인한 뒤 새 메시지를 요청해 주세요. 자동 재실행하지 않습니다.'; store.save(work);
    }
  }
  private documents(work: Work) {
    const root = within(this.legacy.source(work.sourceId).path, `changes/${work.changeName}`);
    return ['proposal.md', 'design.md', 'tasks.md', ...markdownFiles(join(root, 'specs')).map(path => `specs/${path}`)].flatMap(path => {
      const content = textFile(within(root, path)); return content === null ? [] : [{ path: join(root, path), content }];
    });
  }
  send(id: string, text: string, tool: ToolConfig, phase?: string) {
    const work = this.store.get(id)!;
    if (this.running.has(id) || ['running', 'connecting', 'waiting-input', 'waiting-approval'].includes(work.state)) throw new ConflictException('이미 실행 중입니다. 종료 확인 후 요청해 주세요.');
    const docs = this.documents(work);
    const history = this.store.events(id).filter(event => ['user-message', 'item/agentMessage/delta', 'answer', 'approval'].includes(event.type));
    const prompt = `현재 업무: ${work.changeName}\n업무 ID: ${work.id}\n현재 단계: ${phase || work.phase}\n작업 경로: ${work.projectPath}\n${reviewInstructions}\n사용자와 한국어로 문답한다. 계획 단계에서는 지정된 OpenSpec 변경 문서만 작성·수정하며 제품 코드를 구현하지 않는다. 문서·구현·검증 결과만으로 사용자 검토나 완료를 대체하지 않는다.\n저장 대화:\n${JSON.stringify(history)}\n최신 문서:\n${JSON.stringify(docs)}\n사용자 요청:\n${text}`;
    if (Buffer.byteLength(prompt, 'utf8') > 256 * 1024) throw new BadRequestException('입력이 256KiB를 초과했습니다. 문서·대화 축약이 필요합니다. 원본 기록은 유지됩니다.');
    if (phase) work.phase = phase;
    work.turnId = randomUUID(); work.state = 'running'; delete work.error; delete work.errorCode;
    this.store.save(work); this.store.event(id, 'user-message', { text });
    if (!readiness(tool).ready) { this.finish(id, 'missing-executable', null); return this.store.get(id); }
    const args = tool.input === 'argument' ? tool.args!.map(arg => arg === '{prompt}' ? prompt : arg) : tool.args!;
    let child: ChildProcess;
    try { child = spawn(tool.executable!, args, { cwd: work.projectPath, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error: any) { this.finish(id, ['E2BIG', 'ENAMETOOLONG'].includes(error.code) ? 'argument-limit' : 'execution-failed', null); return this.store.get(id); }
    let resolveDone!: () => void;
    const execution: Running = { child, done: new Promise(resolve => { resolveDone = resolve; }) }; this.running.set(id, execution);
    let bytes = 0, stderr = '', stdout = false, completed = false;
    const decoder = new StringDecoder('utf8');
    const emit = (delta: string) => { if (delta) { stdout = true; this.store.event(id, 'item/agentMessage/delta', { turnId: work.turnId, itemId: work.turnId, delta, toolId: tool.id }); } };
    const count = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { void this.stop(id, 'output-limit'); return false; } return !execution.stopped; };
    child.stdout!.on('data', (chunk: Buffer) => { if (count(chunk)) emit(decoder.write(chunk)); });
    child.stderr!.on('data', (chunk: Buffer) => { if (count(chunk)) stderr = (stderr + chunk.toString('utf8')).slice(-8192); });
    // EPIPE is expected when a CLI exits without consuming all input; close determines the result.
    child.stdin!.on('error', () => {});
    child.stdin!.end(tool.input === 'stdin' ? prompt : undefined);
    const timer = setTimeout(() => { void this.stop(id, 'timeout'); }, tool.timeoutMs!);
    const close = async (code: number | null, failed = false) => {
      if (completed) return; completed = true; clearTimeout(timer);
      const killed = execution.kill ? await execution.kill : true;
      if (!execution.stopped) emit(decoder.end());
      const reason = !killed ? 'termination-unconfirmed' : execution.stopped || (failed || code !== 0 || !stdout ? (/auth|credential|unauthorized|login|token/i.test(stderr) ? 'authentication-failed' : 'execution-failed') : undefined);
      this.finish(id, reason, code); this.running.delete(id); resolveDone();
    };
    child.once('error', () => { void close(null, true); }); child.once('close', code => { void close(code); });
    return this.store.get(id);
  }
  private finish(id: string, reason: string | undefined, code: number | null) {
    const work = this.store.get(id)!;
    work.state = reason === 'interrupted' ? 'interrupted' : reason === 'termination-unconfirmed' ? 'recovery-required' : reason ? 'failed' : 'idle';
    if (reason) { work.errorCode = reason; work.error = diagnostics[reason]; }
    else { delete work.error; delete work.errorCode; }
    this.store.save(work); this.store.event(id, 'turn/completed', { turn: { id: work.turnId, status: reason === 'interrupted' ? 'interrupted' : reason ? 'failed' : 'completed' }, code, diagnostic: reason }); this.legacy.updates.next();
  }
  private stop(id: string, reason: string) {
    const execution = this.running.get(id); if (!execution) return Promise.resolve(true);
    if (execution.kill) return execution.kill;
    execution.stopped = reason;
    execution.kill = new Promise<boolean>(resolve => {
      const pid = execution.child.pid; if (!pid) { resolve(true); return; }
      if (process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', windowsProcessTreeScript(pid)], { shell: false, windowsHide: true, stdio: 'ignore' });
        const deadline = setTimeout(() => { killer.kill(); execution.child.kill(); resolve(false); }, 10000);
        const killed = (success: boolean) => { if (!success) execution.child.kill(); resolve(success); };
        killer.once('error', () => { clearTimeout(deadline); killed(false); }); killer.once('close', code => { clearTimeout(deadline); killed(code === 0); });
      } else { try { process.kill(-pid, 'SIGKILL'); resolve(true); } catch (error: any) { resolve(error.code === 'ESRCH'); } }
    });
    return execution.kill;
  }
  async interrupt(id: string) { if (!this.running.has(id)) throw new ConflictException('실행 중인 외부 프로세스가 없습니다'); await this.stop(id, 'interrupted'); return { requested: true }; }
  async onModuleDestroy() { await Promise.all([...this.running].map(async ([id, execution]) => { await this.stop(id, 'interrupted'); await execution.done; })); }
}
