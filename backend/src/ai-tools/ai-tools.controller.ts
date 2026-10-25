import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { AiToolConfigService } from './config.service';
@Controller('ai-tools')
export class AiToolsController {
  constructor(@Inject(AiToolConfigService) readonly config: AiToolConfigService) {}
  @Get() get() { return this.config.read(); }
  @Put() save(@Body() body: unknown) { return this.config.save(body); }
}
