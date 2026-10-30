import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { WorkspaceMaintenance } from './WorkspaceMaintenance';
import { readExactMutation } from '../lib/exactMutation';
const space={workId:'w',candidateId:null,targetKind:'work',changeName:'feature',phase:'completed',kind:'git-worktree',rootId:'root',path:'C:/owned/project',spaceStatus:'ready',bytes:1024,capacityStatus:'complete'};
const asset={workId:'w',captureId:'capture',id:'image',createdAt:'2020-01-01',sha256:'a'.repeat(64),bytes:4,state:'available',eligibleForCleanup:true};
const data={version:7,retentionDays:14,measuredAt:'2026-10-30',totalBytes:1024,capacityStatus:'partial',shared:{bytes:null,status:'partial'},roots:[{rootId:'root',path:'C:/old-root',selected:false,capacity:{bytes:1024,freeBytes:null,status:'partial'}}],spaces:[space],images:[asset],nextSpaceAfter:null,nextImageAfter:null};
const response=(value:unknown)=>({ok:true,json:async()=>value});
afterEach(()=>{vi.unstubAllGlobals();localStorage.clear();});
it('설정을 열어도 자동 삭제하지 않고 부분 용량·보존/만료/없는 자료를 구분한다',async()=>{
 const fetcher=vi.fn(async(_url:string,_init?:RequestInit)=>response({...data,spaces:[],images:[asset,{...asset,id:'expired',state:'expired',eligibleForCleanup:false},{...asset,id:'missing',state:'missing',eligibleForCleanup:false}]}));vi.stubGlobal('fetch',fetcher);render(<WorkspaceMaintenance/>);
 expect(fetcher).not.toHaveBeenCalled();fireEvent.click(screen.getByText('용량·공간 정리'));await screen.findByText('C:/old-root');expect(screen.getAllByText(/부분 집계/).length).toBeGreaterThan(0);expect(screen.getByText(/기간 경과/)).toBeVisible();expect(screen.getByText(/만료됨/)).toBeVisible();expect(screen.getByText(/자료 없음/)).toBeVisible();expect(screen.queryByRole('link')).toBeNull();expect(fetcher.mock.calls.every(([,init])=>!init?.method||init.method==='GET')).toBe(true);
});
it('정리 취소는 전송하지 않고 확인 뒤 응답이 유실돼도 정확한 결과 조회로 복구하며 늦은 응답을 무시한다',async()=>{
 let stored:Record<string,unknown>|null=null,reply!:(value:unknown)=>void;
 const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST'){const body=JSON.parse(String(init.body));expect(url).toBe('/api/work/w/workspace/cleanup');expect(body).toMatchObject({token:'nonce',expectedVersion:'version',confirmed:true,requestKey:expect.any(String)});stored={workId:'w',candidateId:null,status:'removed',processTerminated:true,requestKey:body.requestKey,expectedVersion:body.expectedVersion};return new Promise(resolve=>{reply=resolve;});}
  if(url.includes('/cleanup/preview'))return response(stored?{canRemove:false,blockers:[],version:null,target:null}:{canRemove:true,token:'nonce',version:'version',blockers:[],target:{path:space.path,container:'C:/owned',branch:'codex/work-w'}});
  if(url==='/api/work/w/workspace/cleanup')return response({receipt:stored});return response(data);
 });vi.stubGlobal('fetch',fetcher);render(<WorkspaceMaintenance/>);fireEvent.click(screen.getByText('용량·공간 정리'));fireEvent.click(await screen.findByRole('button',{name:'정리 사전 점검'}));const checkbox=await screen.findByLabelText('위 개별 공간의 삭제 범위와 브랜치 보존을 확인했습니다');expect(screen.getByRole('button',{name:'확인한 공간 정리'})).toBeDisabled();fireEvent.click(checkbox);fireEvent.click(screen.getByRole('button',{name:'정리 취소'}));expect(fetcher.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
 const inspect=screen.getByRole('button',{name:'처리 결과 다시 확인'});await waitFor(()=>expect(inspect).toBeEnabled());fireEvent.click(inspect);fireEvent.click(await screen.findByLabelText('위 개별 공간의 삭제 범위와 브랜치 보존을 확인했습니다'));fireEvent.click(screen.getByRole('button',{name:'확인한 공간 정리'}));await waitFor(()=>expect(reply).toBeTypeOf('function'));
 expect(inspect).toBeEnabled();fireEvent.click(inspect);await waitFor(()=>expect(readExactMutation(JSON.stringify(['space-cleanup','w',null]))?.state).toBe('completed'));
 await act(async()=>{reply(response({status:'failed'}));});expect(readExactMutation(JSON.stringify(['space-cleanup','w',null]))?.state).toBe('completed');expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it('기간이 지난 화면도 정확한 사본 범위 확인 전에는 만료 요청을 보내지 않는다',async()=>{
 let expired=false;const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
  if(init?.method==='POST'){expect(url).toBe('/api/work/w/completion/evidence/image/expire');expect(JSON.parse(String(init.body))).toMatchObject({captureId:'capture',expectedHash:'a'.repeat(64),policyVersion:7,confirmed:true,requestKey:expect.any(String)});expired=true;return response({status:'expired'});}
  if(url.includes('/evidence/'))return response({workId:'w',captureId:'capture',id:'image',expectedHash:'a'.repeat(64),state:expired?'expired':'available',eligibleForCleanup:!expired,policyVersion:7});return response({...data,spaces:[],images:[{...asset,state:expired?'expired':'available',eligibleForCleanup:!expired}]});
 });vi.stubGlobal('fetch',fetcher);render(<WorkspaceMaintenance/>);fireEvent.click(screen.getByText('용량·공간 정리'));fireEvent.click(await screen.findByRole('button',{name:'화면 정리 조건 확인'}));const confirm=await screen.findByLabelText('이 완료 캡처의 화면 사본만 만료 처리함을 확인했습니다');expect(screen.getByRole('button',{name:'확인한 화면 사본 만료'})).toBeDisabled();expect(fetcher.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);fireEvent.click(confirm);fireEvent.click(screen.getByRole('button',{name:'확인한 화면 사본 만료'}));await waitFor(()=>expect(expired).toBe(true));await waitFor(()=>expect(screen.queryByRole('button',{name:'확인한 화면 사본 만료'})).toBeNull());expect(screen.queryByRole('link')).toBeNull();
});
