import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LegacyController } from './legacy/legacy.controller';
import { LegacyService } from './legacy/legacy.service';
import { WorkController } from './work/work.controller';
import { WorkService } from './work/work.service';
import { WorkStore } from './work/store';
import { CodexService } from './codex/codex.service';
import { OpenSpecService } from './openspec/openspec.service';
import { ExecutionService } from './work/execution.service';
import { ReviewService } from './review/review.service';
import { AiToolConfigService } from './ai-tools/config.service';
import { AiToolsController } from './ai-tools/ai-tools.controller';
import { AiToolService } from './ai-tools/ai-tool.service';
import { ExternalCliAdapter } from './ai-tools/external-cli.adapter';

@Controller()
class HealthController {
  @Get('health') health() { return 'ok'; }
}

@Module({ controllers: [HealthController, LegacyController, WorkController, AiToolsController], providers: [LegacyService, WorkService, WorkStore, CodexService, OpenSpecService, ExecutionService, ReviewService, AiToolConfigService, AiToolService, ExternalCliAdapter] })
class AppModule {}

export async function createApplication() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.use((req: any, res: any, next: any) => {
    const origin = req.headers.origin;
    if (origin) {
      try { const url = new URL(origin); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return res.status(403).json({ error: '허용되지 않은 Origin입니다' }); }
      catch { return res.status(403).json({ error: '잘못된 Origin입니다' }); }
    }
    next();
  });
  app.enableShutdownHooks();
  return app;
}
