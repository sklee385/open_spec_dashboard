import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { atomicWrite, textFile } from '../files';
import { LegacyService } from '../legacy/legacy.service';
import { WorkStore } from '../work/store';

export type ToolCapabilities = { conversation: boolean; questions: boolean; approval: boolean; interrupt: boolean; nativeResume: boolean };
export type ToolConfig = { id: string; name: string; kind: 'codex' | 'external-cli'; executable?: string; args?: string[]; input?: 'stdin' | 'argument'; timeoutMs?: number };
export const codexTool: ToolConfig = { id: 'codex', name: 'Codex', kind: 'codex' };
export function capabilities(tool: ToolConfig): ToolCapabilities { return { conversation: true, questions: tool.kind === 'codex', approval: tool.kind === 'codex', interrupt: true, nativeResume: tool.kind === 'codex' }; }
export function workTool(work: { toolId?: unknown; toolConfigSnapshot?: unknown }): ToolConfig {
  if (!work.toolId) return { ...codexTool };
  const tool = work.toolConfigSnapshot as ToolConfig | undefined;
  if (!tool || tool.id !== work.toolId || (tool.kind !== 'codex' && tool.kind !== 'external-cli') || (tool.kind === 'codex' && tool.id !== 'codex')) throw new ConflictException('업무의 도구 연결이 잘못되었습니다. 원본 데이터를 확인해 주세요.');
  return tool;
}
function validate(body: any): { defaultToolId: string; tools: ToolConfig[] } {
  if (!body || !Array.isArray(body.tools) || !body.tools.length || body.tools.length > 50) throw new BadRequestException('도구 목록을 확인해 주세요');
  const ids = new Set<string>();
  const tools = body.tools.map((tool: any): ToolConfig => {
    if (!tool || typeof tool.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tool.id) || ids.has(tool.id) || typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 100) throw new BadRequestException('도구 ID·이름이 잘못되었거나 중복되었습니다');
    ids.add(tool.id);
    if (tool.id === 'codex' && tool.kind === 'codex') return { ...codexTool };
    if (tool.id === 'codex' || tool.kind !== 'external-cli' || typeof tool.executable !== 'string' || !isAbsolute(tool.executable) || /[\r\n\0]/.test(tool.executable) || !Array.isArray(tool.args) || tool.args.length > 100 || tool.args.some((arg: unknown) => typeof arg !== 'string' || arg.includes('\0')) || !['stdin', 'argument'].includes(tool.input)) throw new BadRequestException('외부 도구의 절대 실행 경로·인자 배열·입력 방식을 확인해 주세요');
    const placeholders = tool.args.filter((arg: string) => arg.includes('{prompt}'));
    if ((tool.input === 'argument' && (placeholders.length !== 1 || placeholders[0] !== '{prompt}')) || (tool.input === 'stdin' && placeholders.length)) throw new BadRequestException('인자 입력은 단독 {prompt} 인자 하나가 필요합니다');
    const timeoutMs = tool.timeoutMs ?? 600000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) throw new BadRequestException('제한 시간은 1~86400000ms여야 합니다');
    return { id: tool.id, name: tool.name.trim(), kind: tool.kind, executable: tool.executable, args: [...tool.args], input: tool.input, timeoutMs };
  });
  if (!ids.has('codex') || !ids.has(body.defaultToolId)) throw new BadRequestException('내장 Codex와 등록된 기본 도구가 필요합니다');
  return { defaultToolId: body.defaultToolId, tools };
}
export function readiness(tool: ToolConfig) {
  if (tool.kind === 'codex') return { ready: true, code: 'builtin', message: '내장 도구 · 인증은 연결 시 확인합니다' };
  try { if (!statSync(tool.executable!).isFile()) throw new Error(); accessSync(tool.executable!, constants.X_OK); return { ready: true, code: 'available', message: '실행 파일 확인됨 · 인증은 실행 시 확인합니다' }; }
  catch { return { ready: false, code: 'missing-executable', message: '실행 파일이 없거나 실행할 수 없습니다. 설치·경로·권한을 확인해 주세요.' }; }
}
@Injectable()
export class AiToolConfigService {
  readonly path: string;
  constructor(@Inject(LegacyService) legacy: LegacyService, @Inject(WorkStore) private store: WorkStore) { this.path = join(dirname(legacy.configPath), 'ai-tools.json'); }
  read() {
    const raw = textFile(this.path);
    let config;
    try { config = raw === null ? { defaultToolId: 'codex', tools: [{ ...codexTool }] } : validate(JSON.parse(raw)); }
    catch { throw new ConflictException('ai-tools.json 형식이 손상되었습니다. 원본 파일을 복구해 주세요.'); }
    return { ...config, version: createHash('sha256').update(raw ?? 'missing').digest('hex'), tools: config.tools.map(tool => ({ ...tool, capabilities: capabilities(tool), readiness: readiness(tool) })) };
  }
  save(body: any) {
    const current = this.read();
    if (body?.version !== current.version) throw new ConflictException({ message: '다른 창에서 설정이 변경되었습니다. 초안을 보존하고 최신 설정을 다시 불러와 비교해 주세요.', latest: current });
    const next = validate(body), ids = new Set(next.tools.map(tool => tool.id));
    const affected = this.store.list().filter(work => !ids.has(workTool(work).id));
    if (affected.length) throw new ConflictException({ message: '업무에서 참조 중인 도구는 삭제할 수 없습니다', work: affected.map(work => ({ id: work.id, changeName: work.changeName })) });
    atomicWrite(this.path, JSON.stringify(next, null, 2)); return this.read();
  }
  snapshot() { const config = this.read(), tool = config.tools.find(tool => tool.id === config.defaultToolId)!; const { readiness: _status, capabilities: supported, ...snapshot } = tool; return { toolId: tool.id, toolConfigSnapshot: snapshot, toolCapabilities: supported, providerSessionId: null }; }
}
