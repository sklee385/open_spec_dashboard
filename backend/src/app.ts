import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ProjectController } from './projects/project.controller';
import { ProjectResolver } from './projects/resolver';
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
import { DesktopController, DesktopLifecycle } from './desktop/lifecycle';
import { timingSafeEqual } from 'node:crypto';
import { NativeNotifications, NotificationsController } from './notifications/service';
import { WindowsNotifications } from './notifications/adapter';
import { EdgeController } from './browser/edge.controller';
import { EdgeService } from './browser/edge.service';
import { BrowserService } from './browser/browser.service';
import { BrowserController } from './browser/browser.controller';

@Controller()
class HealthController {
  @Get('health') health() { return 'ok'; }
}

@Module({ controllers: [HealthController, LegacyController, WorkController, AiToolsController, DesktopController, NotificationsController, ProjectController, EdgeController, BrowserController], providers: [LegacyService, WorkService, WorkStore, CodexService, OpenSpecService, ExecutionService, ReviewService, AiToolConfigService, AiToolService, ExternalCliAdapter, DesktopLifecycle, WindowsNotifications, NativeNotifications, ProjectResolver, EdgeService, BrowserService] })
class AppModule {}

export async function createApplication() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  app.useBodyParser('json', { limit: '8mb' });
  app.setGlobalPrefix('api');
  const secret = process.env.DESKTOP_TOKEN;
  const lifecycle = app.get(DesktopLifecycle);
  app.use((req: any, res: any, next: any) => {
    if (secret) {
      const provided = Buffer.from(typeof req.headers['x-desktop-token'] === 'string' ? req.headers['x-desktop-token'] : '');
      const expected = Buffer.from(secret);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return res.status(401).json({ error: '앱 인증이 필요합니다' });
      if (lifecycle.locked && !req.url.startsWith('/api/desktop/')) return res.status(503).json({ error: '앱 종료·업데이트 준비 중입니다' });
      const mutation = !['GET','HEAD','OPTIONS'].includes(req.method);
      if (mutation && !req.url.startsWith('/api/desktop/')) {
        if (lifecycle.locked) return res.status(503).json({ error: '앱 종료·업데이트 준비 중입니다' });
        const match = req.url.match(/^\/api\/work\/([a-zA-Z0-9-]+)(?:\/|$)/);
        const completeRequest = lifecycle.beginRequest(match ? 'work-mutation' : 'mutation', match?.[1]);
        let finished = false;
        const done = () => { if (!finished) { finished = true; completeRequest(); } };
        res.once('finish', done); res.once('close', done);
      }
    }
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
