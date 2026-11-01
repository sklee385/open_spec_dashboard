import { BadRequestException, Controller, Get, Inject, Injectable, NotFoundException, Param, Query } from '@nestjs/common';
import { WorkStore, type Work } from './store';
import { desktopHealth } from '../desktop/health';
import { dailyEventFilter } from './daily-events';

export type DailyState = 'running' | 'waiting' | 'error' | 'check' | 'completed' | 'idle';
type QueryInput = { date?: string; zone?: string; sourceId?: string; bucket?: string; page?: string; limit?: string; before?: string; scope?: string };
const integer = (value: string | undefined, fallback: number, maximum: number) => {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new BadRequestException('잘못된 페이지 또는 커서입니다');
  return Number(value);
};
const recordedTime = (value: unknown): string | null => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
export function dailyRange(input: QueryInput) {
  const zone = input.zone ?? 'Asia/Seoul';
  if (!['UTC', 'Asia/Seoul'].includes(zone)) throw new BadRequestException('지원하지 않는 표시 시간대입니다');
  const date = input.date;
  if (!date || !/^\d{4}-\d\d-\d\d$/.test(date) || date < '1970-01-01' || date > '9999-12-30' || !Number.isFinite(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10) !== date) throw new BadRequestException('올바른 날짜가 필요합니다');
  const start = new Date(Date.parse(date+'T00:00:00Z') - (zone === 'Asia/Seoul' ? 9*3600000 : 0)).toISOString();
  return { date, zone, start, end: new Date(Date.parse(start)+86400000).toISOString() };
}

@Injectable()
export class DailyDashboard {
  constructor(@Inject(WorkStore) readonly store: WorkStore) {}
  overview(input: QueryInput) {
    const range = dailyRange(input), page = integer(input.page, 1, 1000000), limit = integer(input.limit, 25, 50), bucket = input.bucket ?? 'activity';
    if (!['activity','carryover'].includes(bucket)) throw new BadRequestException('잘못된 목록 종류입니다');
    if (input.sourceId !== undefined && (typeof input.sourceId !== 'string' || input.sourceId.length > 512 || /[\x00-\x1f]/.test(input.sourceId))) throw new BadRequestException('잘못된 프로젝트입니다');
    // Only aggregates cross the SQL boundary; no full event histories or raw
    // message bodies are loaded to calculate the overview.
    const rows = this.store.db.prepare(`WITH day AS (
      SELECT e.work_id, COUNT(*) activityCount, COUNT(DISTINCT CASE WHEN e.type='turn/started' THEN COALESCE(json_extract(e.data,'$.turn.id'),json_extract(e.data,'$.turnId'),'seq:'||e.seq) END) turnCount,
        MIN(e.created_at) firstDayActivity, MAX(e.created_at) lastDayActivity,
        MAX(CASE WHEN e.type='completed' AND json_extract(e.data,'$.confirmed')=1 THEN 1 ELSE 0 END) explicitlyCompleted
      FROM events e WHERE e.created_at>=? AND e.created_at<? AND ${dailyEventFilter()} GROUP BY e.work_id
    ) SELECT w.data, COALESCE(day.activityCount,0) activityCount, COALESCE(day.turnCount,0) turnCount, day.firstDayActivity, day.lastDayActivity, COALESCE(day.explicitlyCompleted,0) explicitlyCompleted,
      (SELECT MAX(e.created_at) FROM events e WHERE e.work_id=w.id AND ${dailyEventFilter()} AND julianday(e.created_at) IS NOT NULL) lastActivity,
      (SELECT MIN(json_extract(r.data,'$.createdAt')) FROM records r WHERE r.work_id=w.id AND r.kind='question' AND json_extract(r.data,'$.status')='pending' AND json_extract(r.data,'$.kind') IN ('input','approval')) waitingSince,
      EXISTS(SELECT 1 FROM records r WHERE r.work_id=w.id AND r.kind='question' AND json_extract(r.data,'$.status')='pending' AND json_extract(r.data,'$.kind') IN ('input','approval')) pending,
      (SELECT json_extract(e.data,'$.title') FROM events e WHERE e.work_id=w.id AND e.type='source-idea' ORDER BY e.seq LIMIT 1) title
      FROM work w LEFT JOIN day ON day.work_id=w.id WHERE (? IS NULL OR w.source_id=?)`).all(range.start, range.end, input.sourceId || null, input.sourceId || null) as any[];
    const checkedAt = new Date().toISOString();
    const items = rows.map(row => {
      const work = JSON.parse(row.data) as Work, runtime = desktopHealth(this.store).runtime(work);
      const state: DailyState = row.pending ? 'waiting' : runtime === 'active' ? 'running' : runtime === 'unknown' ? 'check' : ['failed','error'].includes(work.state) ? 'error' : ['completed','archived'].includes(work.phase) ? 'completed' : 'idle';
      const lastActivity = recordedTime(row.lastActivity), waitingSince = recordedTime(row.waitingSince);
      const unresolved = ['running','waiting','error','check'].includes(state);
      // A last activity time cannot establish when a current error/run began.
      // Legacy states without an attributable onset stay explicitly unconfirmed.
      const unresolvedSince = state === 'waiting' ? waitingSince : null;
      const carryover = unresolved && unresolvedSince !== null && unresolvedSince < range.start;
      return { workId: work.id, sourceId: work.sourceId, changeName: work.changeName, title: typeof row.title === 'string' && row.title ? row.title : work.changeName,
        activityCount: Number(row.activityCount), turnCount: Number(row.turnCount), firstDayActivity: recordedTime(row.firstDayActivity), lastDayActivity: recordedTime(row.lastDayActivity), explicitlyCompleted: !!row.explicitlyCompleted,
        current: { state, runtime, phase: work.phase, storedState: work.state, checkedAt }, lastActivity, waitingSince, carryover, unresolvedTimeUnknown: unresolved && !unresolvedSince };
    });
    const activity = items.filter(item => item.activityCount > 0).sort((a,b) => (b.lastDayActivity || '').localeCompare(a.lastDayActivity || '') || a.workId.localeCompare(b.workId));
    const carryover = items.filter(item => item.carryover || item.unresolvedTimeUnknown).sort((a,b) => (a.waitingSince || a.lastActivity || '').localeCompare(b.waitingSince || b.lastActivity || '') || a.workId.localeCompare(b.workId));
    const selected = bucket === 'activity' ? activity : carryover;
    return { ...range, checkedAt, summary: { activeWorks: activity.length, explicitlyCompleted: items.filter(item => item.explicitlyCompleted).length,
      currentRunning: items.filter(item => item.current.state === 'running').length, currentWaiting: items.filter(item => item.current.state === 'waiting').length,
      currentErrors: items.filter(item => item.current.state === 'error').length, currentCheck: items.filter(item => item.current.state === 'check').length, carryover: carryover.length },
      bucket, page, limit, total: selected.length, items: selected.slice((page-1)*limit,page*limit), hasMore: selected.length > page*limit };
  }
  history(workId: string, input: QueryInput) {
    if (!this.store.get(workId)) throw new NotFoundException('업무를 찾을 수 없습니다');
    const range = dailyRange(input), limit = integer(input.limit,30,50), before = integer(input.before, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), scope = input.scope ?? 'day';
    if (!['day','all'].includes(scope)) throw new BadRequestException('잘못된 이력 범위입니다');
    const rows = this.store.db.prepare(`SELECT e.seq,e.type,e.data,e.created_at FROM events e WHERE e.work_id=? AND e.seq<? AND (?='all' OR (e.created_at>=? AND e.created_at<?)) AND ${dailyEventFilter()} ORDER BY e.seq DESC LIMIT ?`).all(workId,before,scope,range.start,range.end,limit+1) as any[];
    const events = rows.slice(0,limit).map(row => {
      const data = JSON.parse(row.data);
      const text = row.type === 'user-message' ? data.text : row.type === 'item/completed' ? data.item?.text : row.type === 'document-saved' ? data.path : row.type === 'verification' ? data.commandId : undefined;
      return { seq:Number(row.seq), type:row.type, createdAt:recordedTime(row.created_at), turnId: typeof (data.turn?.id ?? data.turnId) === 'string' ? data.turn?.id ?? data.turnId : null,
        status: typeof (data.turn?.status ?? data.status) === 'string' ? data.turn?.status ?? data.status : null, excerpt: typeof text === 'string' ? text.slice(0,240) : null };
    });
    return { workId, ...range, scope, events, nextBefore:rows.length>limit ? events.at(-1)!.seq : null };
  }
}
@Controller('daily')
export class DailyDashboardController {
  constructor(@Inject(DailyDashboard) readonly dashboard: DailyDashboard) {}
  @Get() overview(@Query() input: QueryInput) { return this.dashboard.overview(input); }
  @Get(':workId/events') history(@Param('workId') id: string, @Query() input: QueryInput) { return this.dashboard.history(id,input); }
}
