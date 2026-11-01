import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { DailyDashboard } from './DailyDashboard';
import type { DailyOverview, DailyWork } from '../types/daily';
const work:DailyWork={workId:'w',sourceId:'source',changeName:'feature',title:'문서 검토',activityCount:3,turnCount:2,firstDayActivity:'2026-11-01T00:00:00Z',lastDayActivity:'2026-11-01T01:00:00Z',lastActivity:'2026-11-01T01:00:00Z',waitingSince:null,explicitlyCompleted:false,carryover:false,unresolvedTimeUnknown:false,current:{state:'check',runtime:'unknown',phase:'implementation',storedState:'running',checkedAt:'2026-11-01T01:00:00Z'}};
const overview=(url:URL,items=[work]):DailyOverview=>({date:url.searchParams.get('date')!,zone:url.searchParams.get('zone')!,checkedAt:'2026-11-01T01:00:00Z',bucket:'activity',page:1,limit:25,total:items.length,hasMore:false,items,summary:{activeWorks:items.length,explicitlyCompleted:0,currentRunning:0,currentWaiting:0,currentErrors:0,currentCheck:items.length,carryover:0}});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('날짜 활동과 현재 확인 필요를 나눠 표시하고 조회와 원문 이동만 수행한다',async()=>{
  const open=vi.fn(),fetcher=vi.fn(async(input:string,_options?:RequestInit)=>({ok:true,json:async()=>overview(new URL(input,'http://test'))}));vi.stubGlobal('fetch',fetcher);
  render(<DailyDashboard sourceId="source" onOpenWork={open}/>);
  expect(await screen.findByText('문서 검토')).toBeInTheDocument();expect(screen.getByText('주요 활동 3건 · 실행 회차 2회')).toBeInTheDocument();expect(screen.getAllByText('확인 필요')).toHaveLength(2);expect(screen.queryByRole('button',{name:'재실행'})).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('활동 날짜'),{target:{value:'2026-10-30'}});await waitFor(()=>expect(fetcher.mock.calls.at(-1)![0]).toContain('date=2026-10-30'));
  fireEvent.change(screen.getByLabelText('표시 시간대'),{target:{value:'UTC'}});await waitFor(()=>expect(fetcher.mock.calls.at(-1)![0]).toContain('zone=UTC'));
  await screen.findByText('문서 검토');fireEvent.click(screen.getByRole('button',{name:'원문 대화로 이동'}));expect(open).toHaveBeenCalledWith('w',undefined);
  expect(fetcher.mock.calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true);
});
it('주요 이력과 이전 페이지를 합치고 선택한 원문 seq를 전달한다',async()=>{
  const open=vi.fn();vi.stubGlobal('fetch',vi.fn(async(input:string)=>{const url=new URL(input,'http://test');return{ok:true,json:async()=>url.pathname.endsWith('/events')?{workId:'w',scope:'day',events:url.searchParams.has('before')?[{seq:4,type:'user-message',createdAt:null,status:null,turnId:null,excerpt:'이전 메시지'}]:[{seq:11,type:'item/completed',createdAt:'2026-11-01T00:00:00Z',status:null,turnId:'t',excerpt:'검토 답변'}],nextBefore:url.searchParams.has('before')?null:11}:overview(url)};}));
  render(<DailyDashboard sourceId={null} onOpenWork={open}/>);fireEvent.click(await screen.findByRole('button',{name:'문서 검토'}));const history=await screen.findByRole('region',{name:'주요 이력'});expect(await within(history).findByText('검토 답변')).toBeInTheDocument();fireEvent.click(within(history).getByRole('button',{name:'이전 기록 더 보기'}));expect(await within(history).findByText('이전 메시지')).toBeInTheDocument();expect(within(history).getAllByText('검토 답변')).toHaveLength(1);expect(within(history).getByText('기록 없음')).toBeInTheDocument();fireEvent.click(within(history).getAllByRole('button',{name:'원문 대화로 이동'})[0]);expect(open).toHaveBeenCalledWith('w',11);
});
it('프로젝트를 바꾼 뒤 늦게 온 이전 조회가 새 결과를 덮지 않는다',async()=>{
  let resolveOld!:(value:any)=>void;const old=new Promise(resolve=>{resolveOld=resolve;});
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>{const url=new URL(input,'http://test');if(url.searchParams.get('sourceId')==='old')return old;return{ok:true,json:async()=>overview(url,[{...work,title:'새 프로젝트 업무'}])};}));
  const view=render(<DailyDashboard sourceId="old" onOpenWork={()=>{}}/>);view.rerender(<DailyDashboard sourceId="new" onOpenWork={()=>{}}/>);expect(await screen.findByText('새 프로젝트 업무')).toBeInTheDocument();resolveOld({ok:true,json:async()=>overview(new URL('http://test?date=2026-01-01&zone=UTC'),[{...work,title:'이전 프로젝트 업무'}])});await waitFor(()=>expect(screen.queryByText('이전 프로젝트 업무')).not.toBeInTheDocument());
});
it('빈 날짜와 실패를 구분하고 원문 이동 실패에도 목록을 유지한다',async()=>{
  let fail=false;vi.stubGlobal('fetch',vi.fn(async(input:string)=>{if(fail)throw Error('offline');return{ok:true,json:async()=>overview(new URL(input,'http://test'))};}));
  render(<DailyDashboard sourceId={null} onOpenWork={async()=>{throw Error('unavailable');}}/>);await screen.findByText('문서 검토');fireEvent.click(screen.getByRole('button',{name:'원문 대화로 이동'}));expect(await screen.findByRole('alert')).toHaveTextContent('원문 업무를 열지 못했습니다');expect(screen.getByText('문서 검토')).toBeInTheDocument();fail=true;fireEvent.click(screen.getByRole('button',{name:'새로고침'}));await waitFor(()=>expect(screen.getAllByRole('alert').some(node=>node.textContent?.includes('마지막 정상 조회'))).toBe(true));
});
it('활동 없는 날짜는 빈 상태와 실제 0을 표시한다',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>({ok:true,json:async()=>overview(new URL(input,'http://test'),[])})));
  render(<DailyDashboard sourceId={null} onOpenWork={()=>{}}/>);expect(await screen.findByText('이 날짜에 기록된 주요 활동이 없습니다.')).toBeInTheDocument();expect(screen.getAllByText('0')).toHaveLength(6);
});
