import { BadRequestException, ConflictException } from '@nestjs/common';
import type { BrowserService } from './browser.service';
const runId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function browserRunBody(input: unknown): string | undefined {
  if (input === undefined || input === null) return;
  if (typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('등록된 대상의 시나리오만 실행할 수 있습니다');
  if (!Object.keys(input).length) return;
  if (Object.keys(input).length !== 1 || !('requestKey' in input) || !runId(input.requestKey)) throw new BadRequestException('정확한 실행 요청 키만 지정해 주세요');
  return input.requestKey;
}
export function runBrowserTarget(browser: BrowserService, workId: string, candidateId: string | null, input: unknown) {
  const key = browserRunBody(input);
  if (!key) return candidateId ? browser.run(workId, 'user', candidateId) : browser.run(workId);
  browser.store.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS browser_user_request_key ON records(work_id,json_extract(data,'$.requestKey')) WHERE kind='browser-verification' AND json_extract(data,'$.owner')='user' AND json_type(data,'$.requestKey')='text'");
  const receipt = () => {
    const row = browser.store.db.prepare("SELECT id,json_extract(data,'$.candidateId') candidateId,json_extract(data,'$.status') runStatus FROM records WHERE work_id=? AND kind='browser-verification' AND json_extract(data,'$.owner')='user' AND json_extract(data,'$.requestKey')=?").get(workId, key) as { id: string; candidateId: string | null; runStatus: string } | undefined;
    if (!row) return;
    if ((row.candidateId ?? null) !== candidateId) throw new ConflictException('이 요청 키는 다른 검증 대상에 사용되었습니다');
    return { ...row, candidateId, targetKind: candidateId ? 'integration-candidate' : 'work', requestKey: key, status: 'accepted' };
  };
  const existing = receipt(); if (existing) return existing;
  try { browser.run(workId, 'user', candidateId ?? undefined, undefined, key); }
  catch (error) { const accepted = receipt(); if (accepted) return accepted; throw error; }
  const accepted = receipt(); if (!accepted) throw new ConflictException('실행 수락 상태를 다시 확인해 주세요'); return accepted;
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
export function reconcileBrowserTarget(browser: BrowserService, workId: string, candidateId: string | null, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || Object.keys(input).some(key => !['runId', 'confirmed'].includes(key)) || !('runId' in input) || !runId(input.runId) || !('confirmed' in input) || input.confirmed !== true) throw new BadRequestException('정확한 실행 ID와 종료 재확인 요청이 필요합니다');
  const stored = browser.store.db.prepare("SELECT data FROM records WHERE id=? AND work_id=? AND kind='browser-verification'").get(input.runId, workId) as {data: string} | undefined;
  const row = stored ? JSON.parse(stored.data) : undefined;
  if (!row || (row.candidateId ?? null) !== candidateId) throw new ConflictException('해당 대상의 실행을 찾을 수 없습니다');
  if (row.processTerminated === true && row.cleanupStatus === 'confirmed' && row.reconciliation === 'terminated') return { ...row, id: input.runId, workId };
  return browser.reconcile(workId, input.runId, true);
}
