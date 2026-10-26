import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { WorkRoom } from '../components/WorkRoom';
import { SettingsModal } from '../components/SettingsModal';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { createTranslator } from './messages';
import { ProductError, errorMessage } from './errors';
import type { Change } from '../types';

const change = { id: 'demo/feature', name: 'feature', sourceId: 'demo' } as Change;
const base = { id: 'w', phase: 'implementation', state: 'idle', reviewedVersion: 'v1', documents: ['proposal.md'], events: [], questions: [], verifications: [], verificationCommands: [], changes: [] };
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it.each(['ko', 'en'] as const)('%s 설정 저장 값과 실패 시 복구를 유지한다', async locale => {
  const t = createTranslator(locale);
  const original = { name: '원문 source', path: '/original/openspec' };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => ({ ok: !init, status: 500, text: async () => JSON.stringify(init ? { error: '원문 server error' } : { sources: [original] }) }));
  vi.stubGlobal('fetch', fetch);
  render(<SettingsModal open onOpenChange={() => {}} />, { locale });
  await screen.findByText('원문 source');
  const name = screen.getByLabelText(t('settings.name'));
  await waitFor(() => expect(name).not.toBeDisabled());
  fireEvent.change(name, { target: { value: '새 original' } });
  fireEvent.change(screen.getByLabelText(t('settings.path')), { target: { value: '/new/원문' } });
  fireEvent.click(screen.getByRole('button', { name: t('settings.add') }));
  await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
  const body = JSON.parse(fetch.mock.calls.find(([, init]) => init?.method === 'PUT')![1]!.body as string);
  expect(body).toEqual({ sources: [original, { name: '새 original', path: '/new/원문' }] });
  await waitFor(() => expect(screen.queryByText('새 original')).not.toBeInTheDocument());
  expect(screen.getByText('/original/openspec')).toBeInTheDocument();
});

it.each(['ko', 'en'] as const)('%s 질문 선택지와 응답 데이터를 보존한다', async locale => {
  const t = createTranslator(locale);
  const work = { ...base, questions: [{ id: 'q', kind: 'input', status: 'pending', params: { questions: [{ id: 'choice', question: '원문 확인 질문', options: [{ label: '원문 선택', description: '原文 option' }] }] } }] };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => { void init; return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '# 원문', version: 'v1' } : work }; });
  vi.stubGlobal('fetch', fetch);
  render(<WorkRoom change={change} onClose={() => {}} />, { locale });
  await screen.findByRole('textbox', { name: '원문 확인 질문' });
  fireEvent.click(await screen.findByRole('button', { name: /원문 선택.*原文 option/ }));
  expect(screen.getByRole('textbox', { name: '원문 확인 질문' })).toHaveValue('원문 선택');
  fireEvent.click(screen.getByRole('button', { name: t('workRoom.answer') }));
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/answer'))).toBe(true));
  const request = fetch.mock.calls.find(([url]) => url.endsWith('/answer'))!;
  expect(JSON.parse(request[1]!.body as string)).toEqual({ questionId: 'q', recover: false, answers: { choice: { answers: ['원문 선택'] } } });
});

it.each(['ko', 'en'] as const)('%s 검증 상태만 번역하고 실행·파일 원문과 명령을 유지한다', async locale => {
  const t = createTranslator(locale);
  const work = { ...base, verificationCommands: [{ id: '원문 test', command: 'npm', args: ['run', 'test'] }], verifications: [{ id: 'v', commandId: '원문 test', status: 'passed', fresh: true, stdout: '원문 stdout', stderr: '原文 stderr', code: 0 }], changes: [{ path: '원문/file.ts', status: 'modified', before: '원문 before', after: '原文 after' }] };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => { void init; return { ok: true, json: async () => url.includes('/document') ? { path: 'proposal.md', content: '# 원문', version: 'v1' } : work }; });
  vi.stubGlobal('fetch', fetch);
  render(<WorkRoom change={change} onClose={() => {}} />, { locale });
  await screen.findByRole('textbox', { name: t('workRoom.content') });
  fireEvent.click(screen.getByRole('button', { name: t('workRoom.results') }));
  expect(screen.getByText(`원문 test · ${t('workRoom.passed')} · ${t('workRoom.currentVersion')}`)).toBeInTheDocument();
  expect(screen.getByText(`${t('workRoom.modified')} · 원문/file.ts`)).toBeInTheDocument();
  expect(screen.getByText(/원문 stdout/)).toHaveTextContent('原文 stderr');
  expect(screen.getByText('원문 before')).toBeInTheDocument();
  expect(screen.getByText('原文 after')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: t('tests.full') }));
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith('/verify-all'))).toBe(true));
  expect(JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith('/verify-all'))![1]!.body as string)).toEqual({ scope: 'full' });
});

it.each(['ko', 'en'] as const)('%s OpenSpec 요청과 AI 요청 준비 문구를 유지한다', async locale => {
  const t = createTranslator(locale);
  const fetch = vi.fn(async (url: string, init?: RequestInit) => { void init; return { ok: true, json: async () => url.includes('/openspec?') ? { ok: false, stdout: '원문 stdout', stderr: '原文 stderr' } : url.includes('/document') ? { path: 'proposal.md', content: '# 원문', version: 'v1' } : base }; });
  vi.stubGlobal('fetch', fetch);
  render(<WorkRoom change={change} onClose={() => {}} />, { locale });
  await screen.findByRole('textbox', { name: t('workRoom.content') });
  fireEvent.click(screen.getByRole('button', { name: 'OpenSpec' }));
  fireEvent.change(screen.getByRole('combobox', { name: t('workRoom.specFunction') }), { target: { value: 'validate' } });
  fireEvent.click(screen.getByRole('button', { name: t('workRoom.inspect') }));
  await screen.findByText(t('workRoom.inspectError'));
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/openspec?operation=validate&artifact=proposal'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: t('workRoom.prepareRequest') }));
  expect(screen.getByRole('textbox', { name: t('workRoom.chat') })).toHaveValue('OpenSpec 문서 검증 결과를 확인하고 같은 업무에서 필요한 수정을 해 주세요.\n원문 stdout\n原文 stderr');
});

it.each(['ko', 'en'] as const)('%s 제품 기본 오류는 번역하고 서버 문자열은 재해석하지 않는다', async locale => {
  const t = createTranslator(locale);
  expect(errorMessage(new ProductError('workRoom.noResponse'), t)).toBe(t('workRoom.noResponse'));
  expect(errorMessage(new Error('workRoom.noResponse'), t)).toBe('workRoom.noResponse');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  render(<WorkRoom change={change} onClose={() => {}} />, { locale });
  expect(await screen.findByRole('status')).toHaveTextContent(t('workRoom.requestError'));
});

it('사용자 정의 오류 fallback에 기존 props를 전달한다', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fallback = vi.fn(({ error, retry }: { error: Error; retry: () => void }) => <button onClick={retry}>{error.message}</button>);
  function Broken() { throw new Error('custom 원문'); return null; }
  render(<ErrorBoundary fallback={fallback}><Broken /></ErrorBoundary>);
  expect(screen.getByRole('button', { name: 'custom 원문' })).toBeInTheDocument();
  expect(fallback.mock.calls[0][0].retry).toBeTypeOf('function');
  log.mockRestore();
});
