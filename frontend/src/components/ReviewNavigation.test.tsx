/// <reference types="node" />
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { WorkRoom } from './WorkRoom';
import { DetailModal } from './DetailModal';
import type { Change } from '../types';
import { createHash, webcrypto } from 'node:crypto';

const change = { id: 'demo/feature', name: 'feature', sourceId: 'demo', status: 'todo', hasProposal: true, hasDesign: true } as Change;
const item = { id: 'item', path: 'design.md', startLine: 3, endLine: 3, text: '범위 확인', kind: 'confirm', version: 'v1' };
const work = { id: 'w', phase: 'reviewed', state: 'idle', reviewedVersion: 'reviewed', documents: ['proposal.md', 'design.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] };
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
it('업무 공간에서 변경 상세의 문서·검토 탭을 열 수 있다', async () => {
  setup(); render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.click(screen.getByRole('button', { name: '변경 문서 보기' }));
  expect(await screen.findByRole('dialog')).toBeVisible();
  expect(screen.getByRole('tab', { name: '사용자 검토' })).toBeVisible();
});
function setup() {
  let line = 3, version = 'v1';
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/review-items')) return { ok: true, json: async () => ({ items: [{ ...item, startLine: line, endLine: line, version }], documentVersions: { 'design.md': version }, errors: [] }) };
    if (url.includes('/document')) {
      const path = new URL(url, 'http://localhost').searchParams.get('path') || JSON.parse(init!.body as string).path;
      return { ok: true, json: async () => ({ path, content: path === 'proposal.md' ? '기존 문서' : '# 설계\n\n' + (line === 4 ? '\n' : '') + '- [review:confirm] 범위 확인', version }) };
    }
    return { ok: true, json: async () => work };
  }); vi.stubGlobal('fetch', fetch);
  return { fetch, changeVersion: () => { line = 4; version = 'v2'; } };
}
it.each(['cancel', 'discard', 'save'])('미저장 초안의 %s 선택을 보호하고 원문 위치를 선택한다', async mode => {
  const { fetch } = setup(); render(<WorkRoom change={change} onClose={() => {}} />);
  const editor = await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.change(editor, { target: { value: '미저장 초안' } });
  fireEvent.click(screen.getByRole('button', { name: '사용자 검토' }));
  fireEvent.click(await screen.findByRole('button', { name: /범위 확인/ }));
  fireEvent.click(screen.getByRole('button', { name: mode === 'cancel' ? '취소' : mode === 'discard' ? '폐기 후 이동' : '저장 후 이동' }));
  if (mode === 'cancel') {
    fireEvent.click(screen.getByRole('button', { name: '문서' }));
    expect(await screen.findByRole('textbox', { name: '문서 내용' })).toHaveValue('미저장 초안');
  } else {
    const source = await screen.findByRole('textbox', { name: '문서 내용' }) as HTMLTextAreaElement;
    await waitFor(() => expect(source.value.slice(source.selectionStart, source.selectionEnd)).toBe('- [review:confirm] 범위 확인'));
    expect(source).toHaveFocus();
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(mode === 'save');
  }
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/action'))).toBe(false);
});
it('오래된 줄 번호 대신 최신 버전의 위치로 이동한다', async () => {
  const { changeVersion } = setup(); render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.click(screen.getByRole('button', { name: '사용자 검토' }));
  const button = await screen.findByRole('button', { name: /범위 확인/ }); changeVersion(); fireEvent.click(button);
  const source = await screen.findByRole('textbox', { name: '문서 내용' }) as HTMLTextAreaElement;
  await waitFor(() => expect(source.selectionStart).toBe(source.value.indexOf('- [review:confirm]')));
});
it('변경 상세에 검토 탭과 원문 이동을 제공한다', async () => {
  const content = '# 설계\n\n- [review:confirm] 범위 확인';
  vi.stubGlobal('fetch', vi.fn(async (_url: string) => ({ ok: true, text: async () => JSON.stringify({ ...change, proposal: '# 제안', design: content, specs: [], tasks: null, documentVersions: { 'design.md': 'v1' } }), json: async () => ({ items: [item], documentVersions: { 'design.md': 'v1' }, errors: [] }) })));
  render(<DetailModal change={{ ...change, hasDesign: false }} onClose={() => {}} />);
  expect(await screen.findByRole('tab', { name: '사용자 검토' })).toBeVisible();
  fireEvent.mouseDown(screen.getByRole('tab', { name: '사용자 검토' }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole('button', { name: /범위 확인/ }));
  await waitFor(() => expect(screen.getByRole('tab', { name: '설계' })).toHaveAttribute('aria-selected', 'true'));
  expect(screen.getByText('[review:confirm] 범위 확인').closest('li')).toHaveAttribute('data-review-selected', 'true');
});
it('버전 필드가 없는 실행 중 서버에서도 원문 해시로 위치를 검증한다', async () => {
  const content = '# 설계\n\n- [review:confirm] 범위 확인';
  const version = createHash('sha256').update(content).digest('hex');
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ ...change, proposal: '# 제안', design: content, specs: [], tasks: null }), json: async () => ({ items: [{ ...item, version }], documentVersions: { 'design.md': version }, errors: [] }) })));
  render(<DetailModal change={change} onClose={() => {}} />);
  fireEvent.mouseDown(await screen.findByRole('tab', { name: '사용자 검토' }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole('button', { name: /범위 확인/ }));
  await waitFor(() => expect(screen.getByRole('tab', { name: '설계' })).toHaveAttribute('aria-selected', 'true'));
});
it('선택 중 삭제된 항목은 이동하지 않고 새 목록과 안내를 보여 준다', async () => {
  let removed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('/review-items')
    ? { items: removed ? [] : [item], documentVersions: {}, errors: [] }
    : url.includes('/document') ? { path: 'proposal.md', content: '원문 유지', version: 'v1' } : work })));
  render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.click(screen.getByRole('button', { name: '사용자 검토' }));
  const button = await screen.findByRole('button', { name: /범위 확인/ }); removed = true; fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent('갱신된 목록');
  expect(await screen.findByText('검토 항목이 없습니다.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '문서' }));
  expect(await screen.findByRole('textbox', { name: '문서 내용' })).toHaveValue('원문 유지');
});
it('저장 성공 후 SSE 없이도 검토 목록을 갱신하고 검토 액션은 보내지 않는다', async () => {
  let saved = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') saved = true;
    return { ok: true, json: async () => url.endsWith('/review-items') ? { items: saved ? [{ ...item, text: '저장 후 확인' }] : [], documentVersions: {}, errors: [] }
      : url.includes('/document') ? { path: 'proposal.md', content: saved ? '수정 문서' : '이전 문서', version: saved ? 'v2' : 'v1' } : work };
  }); vi.stubGlobal('fetch', fetch);
  render(<WorkRoom change={change} onClose={() => {}} />);
  fireEvent.change(await screen.findByRole('textbox', { name: '문서 내용' }), { target: { value: '수정 문서' } });
  fireEvent.click(screen.getByRole('button', { name: '문서 저장' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '문서 저장' })).toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: '사용자 검토' }));
  expect(await screen.findByText('저장 후 확인')).toBeVisible();
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/action'))).toBe(false);
});
it('원문을 읽는 동안 추가 선택을 차단하여 겹친 이동을 막는다', async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/review-items')) return { ok: true, json: async () => ({ items: [item], documentVersions: {}, errors: [] }) };
    if (url.includes('path=design.md')) return new Promise(resolve => { finish = resolve; });
    return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '초안', version: 'v1' } : work };
  }));
  render(<WorkRoom change={change} onClose={() => {}} />);
  await screen.findByRole('textbox', { name: '문서 내용' });
  fireEvent.click(screen.getByRole('button', { name: '사용자 검토' }));
  fireEvent.click(await screen.findByRole('button', { name: /범위 확인/ }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(screen.getByRole('button', { name: /범위 확인/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '문서' }));
  expect(screen.getByRole('combobox', { name: '문서 선택' })).toBeDisabled();
  await act(async () => finish({ ok: true, json: async () => ({ path: 'design.md', content: '# 설계\n\n- [review:confirm] 범위 확인', version: 'v1' }) }));
});
it('다른 변경으로 전환한 뒤 도착한 이전 원문 응답을 무시한다', async () => {
  let reads = 0, finish!: (value: string) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/review-items')) return { ok: true, json: async () => ({ items: [item], documentVersions: {}, errors: [] }) };
    if (url.includes('other')) return { ok: true, text: async () => JSON.stringify({ ...change, proposal: '새 변경 문서', specs: [], tasks: null, design: null }) };
    ++reads;
    return { ok: true, text: () => reads === 1 ? Promise.resolve(JSON.stringify({ ...change, proposal: '이전 변경 문서', specs: [], tasks: null, design: null })) : new Promise(resolve => { finish = resolve; }) };
  }));
  const view = render(<DetailModal change={change} onClose={() => {}} />);
  await screen.findByText('이전 변경 문서');
  fireEvent.mouseDown(screen.getByRole('tab', { name: '사용자 검토' }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole('button', { name: /범위 확인/ }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  view.rerender(<DetailModal change={{ ...change, id: 'demo/other', name: 'other' }} onClose={() => {}} />);
  await screen.findByText('새 변경 문서');
  await act(async () => finish(JSON.stringify({ ...change, proposal: '이전 변경 문서', design: '- [review:confirm] 범위 확인', specs: [], tasks: null, documentVersions: { 'design.md': 'v1' } })));
  expect(screen.getByText('새 변경 문서')).toBeVisible();
  expect(screen.getByRole('tab', { name: '제안서' })).toHaveAttribute('aria-selected', 'true');
});
