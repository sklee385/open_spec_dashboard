import { ConflictException, Controller, Get, Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { resolve } from 'node:path';
import { DesktopLifecycle } from '../desktop/lifecycle';
import { WorkController } from '../work/work.controller';
import { RemoteBridge } from './bridge';

@Injectable()
export class RemoteService implements OnModuleInit, OnModuleDestroy {
  private bridge?: RemoteBridge;
  private reason?: string;
  constructor(@Inject(ModuleRef) private readonly module: ModuleRef, @Inject(DesktopLifecycle) private readonly lifecycle: DesktopLifecycle) {}
  async onModuleInit() {
    const controller = this.module.get(WorkController, { strict: false });
    this.bridge = new RemoteBridge(resolve(process.env.DATA_DIR || '../.data'), {
      list: () => controller.list(), get: id => controller.get(id),
      execute: (action, id, body) => {
        this.lifecycle.assertUnlocked();
        if (['answer','approval'].includes(action)) {
          const question = controller.service.store.records(id, 'question').find(row => row.id === body.questionId);
          if (!question || question.status !== 'pending' || question.generation !== body.generation) throw new ConflictException('질문·승인 ID 또는 버전이 만료되었습니다');
        }
        switch (action) {
          case 'message': return controller.message(id, body);
          case 'answer': return controller.answer(id, body);
          case 'approval': return controller.approval(id, body);
          case 'interrupt': return controller.interrupt(id);
          case 'reconnect': return controller.reconnect(id);
          case 'cancel-session-recovery': {
            const cancel = (controller as any).cancelSessionRecovery;
            if (typeof cancel !== 'function') throw new ConflictException('복구 중단을 사용할 수 없습니다');
            return cancel.call(controller, id, body);
          }
          case 'recover-session': {
            const recovery = (controller as any).recoverSession;
            if (typeof recovery !== 'function') throw new ConflictException('세션 복구를 사용할 수 없습니다');
            return recovery.call(controller, id, body);
          }
          default: throw new ConflictException('지원하지 않는 원격 동작입니다');
        }
      },
    }, this.lifecycle);
    try { await this.bridge.start(); } catch { await this.bridge.close(); this.bridge = undefined; this.reason = '원격 연결을 준비하지 못했습니다. 다른 Board 실행 여부, 연결 파일 권한과 명령 기록을 확인해 주세요.'; }
  }
  async onModuleDestroy() { await this.bridge?.close(); }
  info() { return { available: !!this.bridge, ...(this.reason ? { reason: this.reason } : {}), connectionPath: this.bridge?.connectionPath, cliPath: resolve(__dirname, '../../scripts/board-remote.cjs'), nodePath: process.execPath, transport: 'loopback', mobileVerified: false }; }
}
@Controller('remote')
export class RemoteController {
  constructor(@Inject(RemoteService) private readonly remote: RemoteService) {}
  @Get() info() { return this.remote.info(); }
}
