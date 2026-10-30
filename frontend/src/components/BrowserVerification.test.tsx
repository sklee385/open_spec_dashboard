import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { BrowserVerification } from './BrowserVerification';
afterEach(() => vi.unstubAllGlobals());
it('사용자 시나리오 저장과 실행을 제공하고 미실행을 통과로 표시하지 않는다', async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => ({ ok: true, json: async () => init?.method === 'POST' ? { id: 'run', status: 'running' } : { scenario: null, running: false, busy: false, results: [] } }));
  vi.stubGlobal('fetch', fetch); render(<BrowserVerification workId="one" phase="implementation" state="idle" />);
  fireEvent.click(screen.getByText('백그라운드 브라우저 검증'));
  expect(await screen.findByText('아직 실행하지 않았습니다')).toBeVisible();
  expect(screen.getByRole('button', { name: '시나리오 실행' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '시나리오 저장' }));
  await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
  expect((screen.getByLabelText('시나리오 JSON') as HTMLTextAreaElement).value).toContain('14321');
});
it('오래된 통과와 실패 증거를 표시하고 실행 중 중단할 수 있다', async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ scenario: { name: '저장' }, running: true, busy: true, results: [{ id: 'old', status: 'passed', fresh: false, steps: [], image: 'data:image/jpeg;base64,YQ==' }] }) }));
  vi.stubGlobal('fetch', fetch); render(<BrowserVerification workId="two" phase="verification" state="running" />);
  fireEvent.click(screen.getByText('백그라운드 브라우저 검증'));
  expect(await screen.findByText(/다시 검증 필요/)).toBeVisible();
  expect(screen.getByRole('img', { name: '검증 화면' })).toHaveAttribute('src', 'data:image/jpeg;base64,YQ==');
  fireEvent.click(screen.getByRole('button', { name: '브라우저 검증 중단' }));
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(true));
});

it('cheap 조회는 최신성 미확인과 실제 환경·빌드를 표시하고 명시 검사만 현재 통과를 확인한다', async () => {
  const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ scenario: { name: '저장' }, running: false, busy: false, observation: { state: url.includes('inspect=1') ? 'fresh' : 'not-checked' }, results: [{ id: 'proof', status: 'passed', fresh: url.includes('inspect=1'), freshnessState: url.includes('inspect=1') ? 'fresh' : 'not-checked', targetKind: 'work', environmentId: 'environment-proof', environment: { commit: 'executed-commit', build: { state: 'unprepared' } }, buildAttestation: { buildId: 'actual-build-proof' } }] }) }));
  vi.stubGlobal('fetch', fetcher); render(<BrowserVerification workId="proof" phase="verification" state="idle" />); fireEvent.click(screen.getByText('백그라운드 브라우저 검증'));
  expect(await screen.findByText(/최신성 미확인/)).toBeVisible(); expect(screen.queryByText(/다시 검증 필요/)).toBeNull();
  expect(screen.getByText('environment-proof')).toBeInTheDocument(); expect(screen.getByText('actual-build-proof')).toBeInTheDocument(); expect(screen.getByText('executed-commit')).toBeInTheDocument();
  expect(fetcher.mock.calls.every(([url]) => !url.includes('inspect=1'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '검증 결과 최신성 확인' })); await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith('?inspect=1'))).toBe(true));
  expect(await screen.findByText(/현재 기준과 일치/)).toBeVisible();
});
it('브라우저 실행 POST가 대기해도 결과 조회는 계속 사용할 수 있다', async () => {
  let reply!: (value: unknown) => void;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? new Promise(resolve => { reply = resolve; }) : { ok: true, json: async () => ({ scenario: { name: '등록됨' }, running: false, busy: false, results: [] }) });
  vi.stubGlobal('fetch', fetcher); render(<BrowserVerification workId="pending" phase="verification" state="idle" />); fireEvent.click(screen.getByText('백그라운드 브라우저 검증')); await screen.findByText('아직 실행하지 않았습니다');
  fireEvent.click(screen.getByRole('button', { name: '시나리오 실행' })); await waitFor(() => expect(reply).toBeTypeOf('function'));
  const refresh = screen.getByRole('button', { name: '결과 새로고침' }); expect(refresh).toBeEnabled(); const previous = fetcher.mock.calls.length; fireEvent.click(refresh); await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(previous));
  await act(async () => { reply({ ok: true, json: async () => ({ id: 'run', status: 'running' }) }); });
});
it('후보 화면은 업무 시나리오를 읽기만 하고 같은 후보 실행과 정확한 runId 중단만 요청한다', async () => {
  let running = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { running = url.endsWith('/run'); return { ok: true, json: async () => ({ id: 'candidate-run', requested: true }) }; }
    return { ok: true, json: async () => ({ scenario: { name: '등록됨' }, running, busy: running, live: running ? { id: 'candidate-run', candidateId: 'c' } : null, results: [] }) };
  });
  vi.stubGlobal('fetch', fetcher); render(<BrowserVerification workId="candidate-work" candidateId="c" phase="verification" state="idle" />); fireEvent.click(screen.getByText('후보 브라우저 검증')); await screen.findByText('아직 실행하지 않았습니다');
  expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByRole('button', { name: '시나리오 저장' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '후보 시나리오 실행' })); await screen.findByRole('button', { name: '후보 브라우저 검증 중단' });
  fireEvent.click(screen.getByRole('button', { name: '후보 브라우저 검증 중단' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => url === '/api/work/candidate-work/integration/c/browser/cancel' && init?.body === JSON.stringify({ runId: 'candidate-run' }))).toBe(true));
  expect(fetcher.mock.calls.every(([url]) => url.startsWith('/api/work/candidate-work/integration/c/browser'))).toBe(true);
});
it('후보 브라우저 실행은 저장되지 않은 편집 보호와 읽기 전용 이력을 우회하지 않는다', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ scenario: { name: '등록됨' }, running: false, busy: false, results: [] }) }));
  vi.stubGlobal('fetch', fetcher); const view = render(<BrowserVerification workId="w" candidateId="c" phase="verification" state="idle" beforeRun={() => false} />); fireEvent.click(screen.getByText('후보 브라우저 검증')); await screen.findByText('아직 실행하지 않았습니다');
  fireEvent.click(screen.getByRole('button', { name: '후보 시나리오 실행' })); expect(fetcher.mock.calls).toHaveLength(1);
  view.rerender(<BrowserVerification workId="w" candidateId="c" phase="verification" state="idle" canRun={false} />); expect(screen.getByRole('button', { name: '후보 시나리오 실행' })).toBeDisabled();
});
it('실행 응답 유실 중에도 같은 요청의 서버 수락을 확인한 뒤 정확한 실행을 중단하고 늦은 응답을 무시한다', async () => {
  let reply!:(value:unknown)=>void, key:string|undefined, stopped=false;
  const fetcher=vi.fn(async(_url:string,init?:RequestInit)=>{
    if(init?.method==='POST'){const body=init.body?JSON.parse(String(init.body)):{};if(_url.endsWith('/run')){key=body.requestKey;return new Promise(resolve=>{reply=resolve;});}stopped=true;return {ok:true,json:async()=>({requested:true})};}
    return {ok:true,json:async()=>({scenario:{name:'등록됨'},running:!!key&&!stopped,busy:!!key&&!stopped,live:key&&!stopped?{id:'run-key',candidateId:null,status:'running'}:null,results:key?[{id:'run-key',workId:'receipt-work',candidateId:null,owner:'user',requestKey:key,status:stopped?'interrupted':'running',processTerminated:stopped}]:[]})};
  });
  vi.stubGlobal('fetch',fetcher);render(<BrowserVerification workId="receipt-work" phase="verification" state="idle"/>);fireEvent.click(screen.getByText('백그라운드 브라우저 검증'));await screen.findByText('아직 실행하지 않았습니다');fireEvent.click(screen.getByRole('button',{name:'시나리오 실행'}));await waitFor(()=>expect(key).toBeTypeOf('string'));
  fireEvent.click(screen.getByRole('button',{name:'결과 새로고침'}));const cancel=await screen.findByRole('button',{name:'브라우저 검증 중단'});await waitFor(()=>expect(cancel).toBeEnabled());fireEvent.click(cancel);
  await waitFor(()=>expect(stopped).toBe(true));await act(async()=>{reply({ok:true,json:async()=>({status:'accepted',id:'run-key',requestKey:key})});});expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(2);
});
it('종료 미확인 실행은 ID를 고정해 재확인하고 현재 종료 근거 없는 자동 해제를 요청하지 않는다', async () => {
  let reconciled=false;const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
    if(init?.method==='POST'){expect(url).toBe('/api/work/unknown/browser/reconcile');expect(JSON.parse(String(init.body))).toEqual({runId:'unknown-run',confirmed:true});reconciled=true;return {ok:true,json:async()=>({id:'unknown-run',status:'interrupted',cleanupStatus:'confirmed',reconciliation:'terminated',processTerminated:true})};}
    return {ok:true,json:async()=>({scenario:{name:'등록됨'},running:false,busy:!reconciled,live:reconciled?null:{id:'unknown-run',candidateId:null,status:'unknown'},results:[]})};
  });vi.stubGlobal('fetch',fetcher);render(<BrowserVerification workId="unknown" phase="verification" state="idle"/>);fireEvent.click(screen.getByText('백그라운드 브라우저 검증'));const recover=await screen.findByRole('button',{name:'실행 종료 재확인'});expect(fetcher.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);fireEvent.click(recover);await waitFor(()=>expect(reconciled).toBe(true));
});