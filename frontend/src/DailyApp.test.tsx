import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from './test/render';
import App from './App';
vi.mock('./hooks/useApi',()=>({useSSE:()=>{},useSources:()=>({sources:[],refetch:vi.fn()}),useChanges:()=>({changes:[],refetch:vi.fn()}),useSpecs:()=>({refetch:vi.fn()}),useIdeas:()=>({ideas:[],refetch:vi.fn()})}));
vi.mock('./hooks/useAiActivity',()=>({useAiActivity:()=>({state:'idle',count:0,byChange:new Map()})}));
vi.mock('./components/Header',()=>({Header:({onViewChange}:{onViewChange:(view:string)=>void})=><><button onClick={()=>onViewChange('daily')}>현황판 열기</button><button onClick={()=>onViewChange('kanban')}>보드 열기</button></>}));
vi.mock('./components/DailyDashboard',()=>({DailyDashboard:({onOpenWork}:{onOpenWork:(id:string,seq:number)=>Promise<void>})=><button onClick={()=>void onOpenWork('w',7)}>원문 열기</button>}));
vi.mock('./components/WorkRoom',()=>({WorkRoom:({eventSeq,returnLabel,openChat}:{eventSeq?:number;returnLabel?:string;openChat?:boolean})=><p>원문 위치 {eventSeq??'없음'} · {returnLabel??'기본'} · {openChat?'대화':'저장된 보기'}</p>}));
vi.mock('./components/KanbanBoard',()=>({KanbanBoard:()=><p>보드 본문</p>}));
vi.mock('./components/SettingsModal',()=>({SettingsModal:()=>null}));vi.mock('./components/IdeaCapture',()=>({IdeaCapture:()=>null}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();});
const destination={id:'review/feature',sourceId:'review',name:'feature',status:'draft',title:'원문',proposal:null,design:null,specs:[],tasks:null,schema:'spec-driven',artifacts:[]};
it('현황판의 읽기 전용 원문 요청을 해당 업무/seq와 돌아갈 위치로 연결한다',async()=>{
  const fetcher=vi.fn(async(input:string,_options?:RequestInit)=>({ok:true,json:async()=>input==='/api/work/w'?{id:'w',sourceId:'review',changeName:'feature'}:input.includes('/changes/')?destination:input.includes('/attention')?{items:[]}:input.includes('/trash')?{entries:[]}:{enabled:false}}));vi.stubGlobal('fetch',fetcher);
  render(<App/>);fireEvent.click(screen.getByText('현황판 열기'));fireEvent.click(screen.getByText('원문 열기'));expect(await screen.findByText('원문 위치 7 · 일일 현황으로 돌아가기 · 대화')).toBeInTheDocument();expect(fetcher.mock.calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true);
});
it('원문 응답을 기다리는 동안 다른 화면으로 이동하면 늦은 응답이 화면을 덮지 않는다',async()=>{
  let resolveWork!:(value:unknown)=>void;const pending=new Promise(resolve=>{resolveWork=resolve;});
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>({ok:true,json:async()=>input==='/api/work/w'?pending:input.includes('/changes/')?destination:input.includes('/attention')?{items:[]}:input.includes('/trash')?{entries:[]}:{enabled:false}})));
  render(<App/>);fireEvent.click(screen.getByText('현황판 열기'));fireEvent.click(screen.getByText('원문 열기'));fireEvent.click(screen.getByText('보드 열기'));await act(async()=>{resolveWork({id:'w',sourceId:'review',changeName:'feature'});});expect(screen.getByText('보드 본문')).toBeInTheDocument();expect(screen.queryByText(/원문 위치/)).not.toBeInTheDocument();
});
it('일반 업무 진입은 현황판 원문 이동으로 오인하지 않고 저장된 보기를 유지한다',async()=>{
  localStorage.setItem('openspec-active-change',JSON.stringify({...destination,name:'feature'}));
  vi.stubGlobal('fetch',vi.fn(async(input:string)=>({ok:true,json:async()=>input.includes('/attention')?{items:[]}:input.includes('/trash')?{entries:[]}:{enabled:false}})));
  render(<App/>);expect(screen.getByText('원문 위치 없음 · 기본 · 저장된 보기')).toBeInTheDocument();
});
