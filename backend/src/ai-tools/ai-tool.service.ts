import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { CodexService } from '../codex/codex.service';
import { WorkStore } from '../work/store';
import { ExternalCliAdapter } from './external-cli.adapter';
import { workTool } from './config.service';

export class CodexAdapter {
  constructor(readonly service: CodexService) {}
  send(id: string, text: string, phase?: string) { return this.service.send(id, text, phase); }
  interrupt(id: string) { return this.service.interrupt(id); }
  recover(id: string) { return this.service.reconnect(id); }
  answer(id: string, body: any) { return this.service.answer(id, body); }
  approval(id: string, body: any) { return this.service.approval(id, body); }
}
@Injectable()
export class AiToolService {
  readonly registry: Map<string, CodexAdapter | ExternalCliAdapter>;
  constructor(@Inject(WorkStore) private store: WorkStore, @Inject(CodexService) private codex: CodexService, @Inject(ExternalCliAdapter) private external: ExternalCliAdapter) {
    this.registry = new Map<string, CodexAdapter | ExternalCliAdapter>([['codex', new CodexAdapter(codex)], ['external-cli', external]]);
  }
  private tool(id: string) { const work = this.store.get(id); if (!work) throw new BadRequestException('업무가 없습니다'); const tool = workTool(work); if (!this.registry.has(tool.kind)) throw new ConflictException('등록되지 않은 도구입니다'); return { work, tool }; }
  send(id: string, text: string, phase?: string) {
    const { work, tool } = this.tool(id);
    if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw new BadRequestException('메시지를 입력해 주세요');
    if (['completed', 'archived'].includes(work.phase)) throw new ConflictException('완료된 업무는 수정 단계로 다시 열어 주세요');
    if (['implementation', 'verification'].includes(phase || work.phase)) this.codex.requireReviewedPlan(work);
    return tool.kind === 'codex' ? (this.registry.get('codex') as CodexAdapter).send(id, text, phase) : this.external.send(id, text, tool, phase);
  }
  interrupt(id: string) { return this.tool(id).tool.kind === 'codex' ? this.codex.interrupt(id) : this.external.interrupt(id); }
  private native(id: string) { if (this.tool(id).tool.kind !== 'codex') throw new BadRequestException('이 도구는 구조화 질문·승인·고유 세션 재개를 지원하지 않습니다'); return this.registry.get('codex') as CodexAdapter; }
  reconnect(id: string) { return this.native(id).recover(id); }
  answer(id: string, body: any) { return this.native(id).answer(id, body); }
  approval(id: string, body: any) { return this.native(id).approval(id, body); }
}
