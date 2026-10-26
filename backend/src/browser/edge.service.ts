import { ConflictException, Inject, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { resolve } from 'node:path';
import { EdgeBridge, EdgeInput } from './edge-bridge';
import { Work, WorkStore } from '../work/store';

export const edgeSupported = (work: Work) => (!work.toolId || work.toolId === 'codex') && (!work.threadId || work.edgeToolsVersion === 1);
@Injectable()
export class EdgeService implements OnModuleDestroy {
  readonly bridge = new EdgeBridge();
  constructor(@Inject(WorkStore) private readonly store: WorkStore) {}
  private work(id: string) { const work = this.store.get(id); if (!work) throw new NotFoundException('업무가 없습니다'); return work; }
  status(id: string) {
    const work = this.work(id), supported = edgeSupported(work);
    return { supported, ...this.bridge.status(id), ...(!supported ? { reason: '이 대화에는 Edge 도구가 등록되지 않았습니다. 기존 대화를 보존하며 새 Codex 업무에서 연결할 수 있습니다.' } : {}) };
  }
  settings() { return { extensionPath: resolve(__dirname, '../../../edge-extension'), connections: this.bridge.list() }; }
  pair(id: string) {
    const work = this.work(id);
    if (!edgeSupported(work)) throw new ConflictException('기존 대화는 유지됩니다. 새 Codex 업무에서 Edge를 연결해 주세요.');
    if (['completed', 'archived'].includes(work.phase)) throw new ConflictException('완료한 업무는 다시 연 뒤 연결해 주세요');
    return this.bridge.createPair(id);
  }
  disconnect(id: string) { this.work(id); this.bridge.disconnect(id); return { connected: false }; }
  execute(id: string, input: EdgeInput) {
    if (!edgeSupported(this.work(id))) throw new ConflictException('이 대화에는 Edge 도구가 없습니다');
    return this.bridge.execute(id, input);
  }
  async onModuleDestroy() { await this.bridge.close(); }
}
