import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { WorkRoom } from './WorkRoom';
import { DetailModal } from './DetailModal';
import { SpecsView } from './SpecsView';
import type { Change } from '../types';

const text = '# 같은 문서\n\n| 항목 | 상태 |\n| --- | ---: |\n| 문서 | 완료 |\n\n- [x] 원문 유지\n\n```mermaid\nflowchart LR\nA-->B\n```';
const change = { id: 'demo/markdown', name: 'markdown', sourceId: 'demo', status: 'todo', hasProposal: true, hasSpecs: false, hasTasks: false, hasDesign: false, artifacts: [] } as unknown as Change;
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 200 100"><text>화면 공통 도식</text></svg>' }) } }));
vi.mock('../hooks/useApi', () => ({
  useChange: () => ({ change: { proposal: text, specs: [], tasks: null, design: null }, loading: false }),
  useSpecs: () => ({ specs: [{ id: 'spec', sourceId: 'demo', path: 'markdown/spec.md' }], loading: false }),
  useSpec: () => ({ spec: { content: text, path: 'markdown/spec.md', sourceId: 'demo' }, loading: false }),
}));
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('세 화면에서 동일한 구조를 표시하고 업무 미리보기는 저장 원문을 바꾸지 않는다', async () => {
  const request = vi.fn(async (url: string, _init?: RequestInit) => ({ ok: true, json: async () => url.endsWith('/review-items') ? { items: [], documentVersions: {}, errors: [] } : url.includes('/document') ? { path: 'proposal.md', content: text, version: 'v1' } : { id: 'markdown-work', phase: 'implementation', state: 'idle', documents: ['proposal.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] } }));
  vi.stubGlobal('fetch', request);
  const work = render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
  await screen.findByText('화면 공통 도식');
  const structure = () => ({ table: screen.getByRole('table').outerHTML, checked: screen.getByRole('checkbox').outerHTML });
  const expected = structure();
  fireEvent.click(screen.getByRole('button', { name: '편집' }));
  expect(screen.getByRole('textbox', { name: '문서 내용' })).toHaveValue(text);
  expect(request.mock.calls.some(([, init]: [string, RequestInit?]) => init?.method === 'PUT')).toBe(false);
  work.unmount();
  const details = render(<DetailModal change={change} onClose={() => {}} />);
  await screen.findByText('화면 공통 도식');
  expect(structure()).toEqual(expected);
  details.unmount();
  render(<SpecsView selectedSourceId="demo" />);
  fireEvent.click(screen.getByRole('button', { name: '명세' }));
  fireEvent.click(screen.getByRole('button', { name: 'markdown/spec.md' }));
  await waitFor(() => expect(screen.getByText('화면 공통 도식')).toBeVisible());
  expect(structure()).toEqual(expected);
});
