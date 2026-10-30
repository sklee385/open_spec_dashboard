import { BadRequestException, ConflictException } from '@nestjs/common';
import type { BrowserService } from './browser.service';

const runId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function browserRunBody(input: unknown) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)) throw new BadRequestException('등록된 대상의 시나리오만 실행할 수 있습니다');
}
export function browserCancelBody(input: unknown, required: boolean): string | undefined {
  if (input === undefined || input === null) { if (required) throw new BadRequestException('중단할 브라우저 실행 ID가 필요합니다'); return; }
  if (!required && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0) return;
  if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'runId') || !('runId' in input) || !runId(input.runId)) throw new BadRequestException('정확한 브라우저 실행 ID만 지정해 주세요');
  return input.runId;
}
/** User routes never cancel a different target or a replacement run. */
export function cancelBrowserTarget(browser: BrowserService, workId: string, candidateId: string | null, expectedRunId?: string) {
  const activity = browser.activity(workId, candidateId ?? undefined), live = activity.live;
  if (!activity.running || !live || (live.candidateId ?? null) !== candidateId || expectedRunId && live.id !== expectedRunId) return Promise.resolve({ requested: false });
  const stored = browser.store.db.prepare("SELECT data FROM records WHERE id=? AND work_id=? AND kind='browser-verification'").get(live.id, workId) as { data: string } | undefined;
  const row = stored ? JSON.parse(stored.data) : undefined, contextId = row?.executionBinding?.contextId;
  if ((row?.candidateId ?? null) !== candidateId || typeof contextId !== 'string' || !/^[a-f0-9]{64}$/.test(contextId)) throw new ConflictException('해당 실행의 소유 컨텍스트를 확인할 수 없습니다. 상태를 다시 확인해 주세요');
  return browser.cancel(workId, { contextId, runId: live.id, candidateId });
}