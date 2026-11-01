import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore, type Work } from '../src/work/store';
import { DailyDashboard, dailyRange } from '../src/work/daily-dashboard';
import { desktopHealth } from '../src/desktop/health';

let store: WorkStore, dashboard: DailyDashboard;
beforeEach(() => { process.env.DATA_DIR=mkdtempSync(join(tmpdir(),'daily-')); store=new WorkStore(); dashboard=new DailyDashboard(store); });
afterEach(() => { store.onApplicationShutdown(); delete process.env.DATA_DIR; });
const query={date:'2026-11-01',zone:'Asia/Seoul'};
function work(id='a', overrides:Partial<Work>={}) { const value:Work={id,sourceId:'source',projectPath:'unavailable',changeName:id,requestKey:id,ideaIds:[],phase:'implementation',state:'idle',threadId:null,reviewedVersion:null,createdAt:'',updatedAt:'',...overrides};store.save(value);return value; }
function event(id:string,type:string,data:unknown,at='2026-11-01T01:00:00.000Z') { return Number(store.db.prepare('INSERT INTO events(work_id,type,data,created_at) VALUES(?,?,?,?)').run(id,type,JSON.stringify(data),at).lastInsertRowid); }
it('한국/UTC 날짜 경계를 구분하고 날짜·시간대·페이지를 검증한다',()=>{
  work();event('a','user-message',{text:'전날'},'2026-10-31T14:59:59.999Z');event('a','document-saved',{path:'tasks.md'},'2026-10-31T15:00:00.000Z');event('a','user-message',{text:'다음날'},'2026-11-01T15:00:00.000Z');
  expect(dashboard.overview(query).items[0].activityCount).toBe(1);expect(dashboard.overview({...query,zone:'UTC'}).items[0].activityCount).toBe(1);
  expect(dailyRange(query).start).toBe('2026-10-31T15:00:00.000Z');
  for(const value of [{...query,date:'2026-02-30'},{...query,zone:'unknown'},{...query,page:'0'},{...query,limit:'51'},{...query,bucket:'other'}])expect(()=>dashboard.overview(value)).toThrow();
  expect(()=>dashboard.overview({...query,sourceId:['one','two']} as any)).toThrow();expect(()=>dashboard.overview({...query,date:'9999-12-31'})).toThrow();
});
it('AI 턴 완료를 업무 완료로 세지 않고 고유 업무와 실행 회차를 구분한다',()=>{
  work();event('a','turn/started',{turn:{id:'t1'}});event('a','turn/completed',{turn:{id:'t1',status:'completed'}});event('a','turn/started',{turn:{id:'t2'}});event('a','turn/completed',{turn:{id:'t2',status:'completed'}});
  let result=dashboard.overview(query);expect(result.summary).toMatchObject({activeWorks:1,explicitlyCompleted:0,currentRunning:0});expect(result.items[0].turnCount).toBe(2);expect(result.items[0].current.state).toBe('idle');
  event('a','completed',{confirmed:true});result=dashboard.overview(query);expect(result.summary.explicitlyCompleted).toBe(1);
});
it('stream 조각과 재연결 중복 통지가 날짜를 넘겨도 활동 수와 마지막 의미 시각을 늘리지 않는다',()=>{
  work();event('a','item/agentMessage/delta',{turnId:'t',itemId:'m',delta:'일부'});event('a','item/completed',{turnId:'t',item:{id:'m',type:'agentMessage',text:'원문'}},'2026-10-31T13:00:00.000Z');
  event('a','item/completed',{turnId:'t',item:{id:'m',type:'agentMessage',text:'원문'}},'2026-11-01T01:00:00.000Z');event('a','thread-reconnected',{});event('a','heartbeat',{});
  expect(dashboard.overview(query).summary.activeWorks).toBe(0);expect(dashboard.history('a',{...query,scope:'all'}).events).toHaveLength(1);
  work('b',{state:'failed'});event('b','user-message',{},'2026-10-31T13:00:00.000Z');expect(dashboard.overview({...query,bucket:'carryover'}).items[0].lastActivity).toBe('2026-10-31T13:00:00.000Z');
});
it('저장 running을 실제 실행으로 단정하지 않고 pending과 runtime 근거를 현재 상태로 표시한다',()=>{
  work('a',{state:'running'});work('b');work('c',{state:'failed'});work('d',{phase:'completed'});for(const id of ['a','b','c','d'])event(id,'created',{});
  desktopHealth(store).register('fixture',w=>w.id==='b'?'active':undefined);
  store.record('q','d','question',{kind:'input',status:'pending',createdAt:'2026-10-30T00:00:00.000Z'});
  const result=dashboard.overview(query);expect(result.summary).toMatchObject({currentRunning:1,currentWaiting:1,currentErrors:1,currentCheck:1});
  expect(result.items.find(x=>x.workId==='a')?.current.state).toBe('check');expect(result.items.find(x=>x.workId==='d')?.carryover).toBe(true);
});
it('이전 미해결과 시각 없는 상태를 따로 보존하고 무활동 idle을 멈춤으로 분류하지 않는다',()=>{
  work('old',{state:'failed'});event('old','created',{},'2026-10-30T00:00:00.000Z');work('unknown',{state:'running'});work('idle');
  const result=dashboard.overview({...query,bucket:'carryover'});expect(result.summary.activeWorks).toBe(0);expect(result.items.map(x=>x.workId).sort()).toEqual(['old','unknown']);
  expect(result.items.find(x=>x.workId==='unknown')).toMatchObject({lastActivity:null,carryover:false,unresolvedTimeUnknown:true});
  expect(result.items.find(x=>x.workId==='old')).toMatchObject({lastActivity:'2026-10-30T00:00:00.000Z',carryover:false,unresolvedTimeUnknown:true});
});
it('날짜/전체 주요 이력을 제한·커서로 조회하며 이전 페이지를 중복 반환하지 않는다',()=>{
  work();const first=event('a','user-message',{text:'older'},'2026-10-30T00:00:00.000Z');for(let i=0;i<5;i++)event('a','document-saved',{path:String(i)});
  const a=dashboard.history('a',{...query,limit:'2'}),b=dashboard.history('a',{...query,limit:'2',before:String(a.nextBefore)}),c=dashboard.history('a',{...query,limit:'2',before:String(b.nextBefore)});
  expect(new Set([...a.events,...b.events,...c.events].map(x=>x.seq)).size).toBe(5);expect(c.nextBefore).toBeNull();
  expect(dashboard.history('a',{...query,scope:'all',before:String(c.events.at(-1)!.seq)}).events[0].seq).toBe(first);
  expect(()=>dashboard.history('missing',query)).toThrow();expect(()=>dashboard.history('a',{...query,before:'NaN'})).toThrow();
});
it('집계에서 source를 구분하고 시각을 보정하지 않으며 업무·기록·이벤트를 변경하지 않는다',()=>{
  work();work('b',{sourceId:'other'});event('a','created',{},'');event('b','created',{});const before=store.db.prepare('SELECT total_changes() count').get();
  expect(dashboard.overview({...query,sourceId:'source'}).summary.activeWorks).toBe(0);expect(dashboard.history('a',{...query,scope:'all'}).events[0].createdAt).toBeNull();expect(store.db.prepare('SELECT total_changes() count').get()).toEqual(before);
});
it('업무 목록도 서버 페이지 크기를 지키며 요약은 전체 고유 업무에서 계산한다',()=>{
  for(let i=0;i<6;i++){const id=`work-${i}`;work(id);event(id,'user-message',{});}
  const first=dashboard.overview({...query,limit:'2'}),second=dashboard.overview({...query,limit:'2',page:'2'});
  expect(first.summary.activeWorks).toBe(6);expect(first.items).toHaveLength(2);expect(first.hasMore).toBe(true);expect(second.items).toHaveLength(2);expect(second.items.every(item=>!first.items.some(old=>old.workId===item.workId))).toBe(true);
});
