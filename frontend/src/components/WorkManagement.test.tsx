import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { WorkManagement } from './WorkManagement';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const initial = { workId: 'w', sourceId: 'demo', changeName: 'feature', scope: 'work', runId: 'r1', state: 'automatic', version: 0, observation: 'v1', observed: { phase: 'planning', state: 'running', runtime: 'active' }, history: [] };
const response = (value: unknown, ok = true, status = 200) => ({ ok, status, json: async () => value });
it('displays execution separately, requires a reason, and prevents same-turn duplicate changes', async () => {
  let finish!: (v: unknown) => void;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : response(initial)); vi.stubGlobal('fetch', fetcher);
  await act(async () => { render(<WorkManagement workId="w" initiallyOpen />); });
  expect(screen.getByText(/planning \/ running/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: '관리 상태 반영' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: '변경 사유' }), { target: { value: 'Synthetic reason' } });
  act(() => { const b = screen.getByRole('button', { name: '관리 상태 반영' }); b.click(); b.click(); });
  expect(fetcher.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
  await act(async () => finish(response({ ...initial, state: 'completed', version: 1 })));
  expect(screen.getByRole('status')).toHaveTextContent('관리상 완료'); expect(screen.getByText(/planning \/ running/)).toBeInTheDocument();
});
it('retries an uncertain response using the same key, payload and observed run', async () => {
  let calls = 0;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => { if (init?.method !== 'POST') return response(initial); if (++calls === 1) throw Error('connection lost'); return response({ ...initial, state: 'completed', version: 1 }); }); vi.stubGlobal('fetch', fetcher);
  await act(async () => { render(<WorkManagement workId="w" initiallyOpen />); });
  fireEvent.change(screen.getByRole('textbox', { name: '변경 사유' }), { target: { value: 'Synthetic reason' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '관리 상태 반영' })));
  expect(screen.getByRole('combobox', { name: '변경 범위' })).toBeDisabled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '같은 요청 결과 확인' })));
  const submitted = fetcher.mock.calls.filter(([, i]) => i?.method === 'POST'); expect(submitted[0][1]?.body).toBe(submitted[1][1]?.body);
});
it('reloads after CAS conflicts without silently applying another version', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? response({ message: 'changed' }, false, 409) : response(initial)); vi.stubGlobal('fetch', fetcher);
  await act(async () => { render(<WorkManagement workId="w" initiallyOpen />); });
  fireEvent.change(screen.getByRole('textbox', { name: '변경 사유' }), { target: { value: 'Synthetic reason' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '관리 상태 반영' })));
  expect(screen.getByRole('alert')).toHaveTextContent('changed'); expect(fetcher.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
});
