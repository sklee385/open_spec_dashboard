import { beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { render } from '../test/render';
import { WorkspacePreparation } from './WorkspacePreparation';
import { WorkIntegration } from './WorkIntegration';
import { CandidateEditing } from './CandidateEditing';
import { readMutation } from '../lib/workspaceFlowApi';
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it('pauses integration polling while hidden and reloads only reads when visible again', async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith('reservation-preview') ? { workHead: 'a', sourceBranch: 'main', sourceHead: 'b', reviewedVersion: 'r', branches: [] } : { active: null, requests: [] } })); vi.stubGlobal('fetch', fetcher);
    let view!: ReturnType<typeof render>; await act(async () => { view = render(<WorkIntegration workId="a" active />); }); const before = fetcher.mock.calls.length;
    await act(async () => view.rerender(<WorkIntegration workId="a" active={false} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(fetcher).toHaveBeenCalledTimes(before);
    await act(async () => view.rerender(<WorkIntegration workId="a" active />)); expect(fetcher.mock.calls.length).toBe(before + 2); expect(fetcher.mock.calls.every(call => call.length === 1)).toBe(true);
    view.unmount();
  } finally { vi.useRealTimers(); }
});
it('refreshes only read previews after document review changes and preserves the saved request', async () => {
  let reviewed = false;
  const saved = { endpoint: '/api/work/a/workspace/prepare', body: { requestKey: 'saved', policy: { runtime: 'none' } }, attemptId: 'attempt', state: 'uncertain', createdAt: 'before' };
  localStorage.setItem('workspace-mutation:workspace:a', JSON.stringify(saved));
  const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/preview') ? { ...preparationPreview(reviewed ? 'new' : 'old'), documents: reviewed ? preparationPreview('new').documents : null } : { experimentalEnabled: true, status: 'unprepared' } })); vi.stubGlobal('fetch', fetcher);
  const view = render(<WorkspacePreparation workId="a" reviewedVersion={null} />); await screen.findByRole('option', { name: 'main' }); expect(screen.queryByText('staged.ts', { exact: false })).toBeNull();
  reviewed = true; view.rerender(<WorkspacePreparation workId="a" reviewedVersion="new-review" />);
  expect(await screen.findByText('staged.ts', { exact: false })).toBeVisible(); expect(readMutation('workspace:a')).toEqual(saved);
  expect(fetcher.mock.calls.filter(call => call.length > 1)).toHaveLength(0);
});
it.each(['preparation', 'integration', 'editing'] as const)('announces read-only preview loading in %s', async kind => {
  let finish!: (value: unknown) => void; const fetcher = vi.fn(() => new Promise(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetcher);
  const view = render(kind === 'preparation' ? <WorkspacePreparation workId="a" /> : kind === 'integration' ? <WorkIntegration workId="a" /> : <CandidateEditing workId="a" candidateId="c" dirty={false} onChanged={() => {}} />);
  expect(await screen.findByRole('status')).toHaveTextContent('기준 확인 중…');
  view.unmount(); await act(async () => finish({ ok: true, json: async () => ({ experimentalEnabled: false }) }));
});
const preparationPreview = (token: string) => ({ experimentalEnabled: true, status: 'unprepared', projectId: 'project', preparation: [], git: { state: 'ready', selectedBranch: 'main', head: 'head', baseCommit: 'base', branches: [{ name: 'main', commit: 'base' }] }, documents: { confirmationToken: token, planRevision: 'plan', manifest: { files: [{ path: 'openspec/changes/a/proposal.md' }] }, excluded: [{ path: 'staged.ts', index: 'M', worktree: ' ' }, { path: 'untracked.ts', index: '?', worktree: '?', untracked: true }] } });
it('prepares an explicitly confirmed Node workspace with exact policy and line-based arguments without starting AI', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => { if (init) expect(readMutation('workspace:a')?.body).toEqual(JSON.parse(String(init.body))); return { ok: true, json: async () => init ? { status: 'ready' } : url.includes('/preview') ? preparationPreview('token') : { experimentalEnabled: true, status: 'unprepared' } }; }); vi.stubGlobal('fetch', fetcher);
  render(<WorkspacePreparation workId="a" />); await screen.findByText('staged.ts', { exact: false }); expect(screen.getByText('untracked.ts', { exact: false })).toBeVisible();
  fireEvent.change(screen.getByLabelText('런타임'), { target: { value: 'node' } }); fireEvent.change(screen.getByLabelText('의존성'), { target: { value: 'install' } });
  fireEvent.change(screen.getByLabelText('로컬 자료 경로 (한 줄에 하나)'), { target: { value: '.tools/node-runtime\nfixtures' } }); fireEvent.change(screen.getByLabelText('생성물 경로 (한 줄에 하나)'), { target: { value: 'dist' } });
  fireEvent.click(screen.getByRole('button', { name: '준비 명령 추가' })); fireEvent.change(screen.getByLabelText('명령 ID'), { target: { value: 'install-deps' } }); fireEvent.change(screen.getByLabelText('단계'), { target: { value: 'install' } }); fireEvent.change(screen.getByLabelText('실행 파일'), { target: { value: 'npm' } }); fireEvent.change(screen.getByLabelText('인자 (한 줄에 하나)'), { target: { value: 'ci\n--ignore-scripts' } });
  expect(screen.getByRole('button', { name: '작업 공간 준비' })).toBeDisabled(); expect(fetcher.mock.calls.filter(call => call[1])).toHaveLength(0);
  fireEvent.click(screen.getByLabelText('표시된 기준과 전체 파일 작업을 확인했습니다')); fireEvent.click(screen.getByRole('button', { name: '작업 공간 준비' }));
  await screen.findByText('저장된 요청 완료');
  const posts = fetcher.mock.calls.filter(call => call[1]); expect(posts).toHaveLength(1); expect(posts[0][0]).toBe('/api/work/a/workspace/prepare');
  expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ requestKey: expect.any(String), confirmed: true, selectedBranch: 'main', excludedConfirmed: true, previewToken: 'token', policy: { version: 1, confirmed: true, projectId: 'project', planRevision: 'plan', runtime: 'node', dependencies: 'install', paths: ['.tools/node-runtime', 'fixtures'], generatedPaths: ['dist'], commands: [{ id: 'install-deps', stage: 'install', command: 'npm', args: ['ci', '--ignore-scripts'] }] } });
});
it('shows the actual saved policy and preserves recovery through remount and a late old response', async () => {
  const savedDraft = { branch: 'main', runtime: 'node', dependencies: 'install', paths: 'fixtures', generated: 'dist', commands: [{ id: 'saved-install', stage: 'install', command: 'npm', argsText: 'ci\n--ignore-scripts' }] };
  localStorage.setItem('workspace-preparation-draft:a', JSON.stringify(savedDraft));
  let finishA!: (value: unknown) => void, rejectB!: (error: Error) => void, count = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => { if (init) { count++; if (count === 1) return new Promise(resolve => { finishA = resolve; }); return new Promise((_resolve, reject) => { rejectB = reject; }); } return { ok: true, json: async () => url.includes('/preview') ? preparationPreview(count ? 'renewed' : 'old') : { experimentalEnabled: true, status: 'unprepared' } }; }); vi.stubGlobal('fetch', fetcher);
  const first = render(<WorkspacePreparation workId="a" />); await screen.findByText('staged.ts', { exact: false }); fireEvent.click(screen.getByLabelText('표시된 기준과 전체 파일 작업을 확인했습니다')); fireEvent.click(screen.getByRole('button', { name: '작업 공간 준비' }));
  await waitFor(() => expect(count).toBe(1)); const original = readMutation('workspace:a'); first.unmount();
  localStorage.setItem('workspace-preparation-draft:a', JSON.stringify({ ...savedDraft, runtime: 'none', paths: 'different-draft' }));
  render(<WorkspacePreparation workId="a" />); const snapshot = await screen.findByRole('region', { name: '저장된 준비 정책' });
  expect(within(snapshot).getByText('main')).toBeVisible(); expect(within(snapshot).getByText('Node')).toBeVisible(); expect(within(snapshot).getByText('fixtures')).toBeVisible(); expect(within(snapshot).getByText('dist')).toBeVisible(); expect(within(snapshot).getByText('saved-install')).toBeVisible(); expect(within(snapshot).getByText('npm')).toBeVisible(); expect(within(snapshot).getByText('ci')).toBeVisible(); expect(within(snapshot).getByText('--ignore-scripts')).toBeVisible(); expect(within(snapshot).queryByText('different-draft')).toBeNull();
  const recover = screen.getByRole('button', { name: '갱신 기준으로 기존 준비 복구' }); expect(recover).toBeDisabled(); expect(count).toBe(1);
  fireEvent.click(screen.getByLabelText('저장된 준비 정책과 갱신 기준을 확인했습니다')); fireEvent.click(recover); await waitFor(() => expect(count).toBe(2)); const current = readMutation('workspace:a');
  expect(current?.body).toEqual({ ...original?.body, previewToken: 'renewed' });
  await act(async () => finishA({ ok: false, status: 409, json: async () => ({ mutationOutcome: 'rejected-before-intent', requestKey: original?.body.requestKey }) })); expect(readMutation('workspace:a')).toEqual(current);
  await act(async () => rejectB(new Error('recovery lost'))); expect(readMutation('workspace:a')).toMatchObject({ endpoint: '/api/work/a/workspace/recover', body: current?.body, state: 'uncertain' });
});
it('hides preparation when the experiment is disabled and never starts AI', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ experimentalEnabled: false, status: 'unprepared' }) }); vi.stubGlobal('fetch', fetcher);
  render(<WorkspacePreparation workId="a" />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(screen.queryByText('작업 공간 준비')).not.toBeInTheDocument();
  expect(fetcher.mock.calls.every(call => !call[1])).toBe(true);
});
it('commits an explicit empty-diff conflict resolution with both-parent intent and persists retries across remount', async () => {
  let lost = true;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => { if (init && lost) { lost = false; throw new Error('reply lost'); } return { ok: true, json: async () => init ? { status: 'committed' } : { candidateVersion: 'version', mode: 'conflict', head: 'target', entries: [], conflicts: ['already-resolved.txt'] } }; });
  vi.stubGlobal('fetch', fetcher); const first = render(<CandidateEditing workId="a" candidateId="c" dirty={false} onChanged={() => {}} />);
  await screen.findByText('target', { exact: false }); fireEvent.change(screen.getByLabelText('커밋 메시지'), { target: { value: 'resolve to target' } });
  fireEvent.click(screen.getByLabelText('표시된 기준과 전체 파일 작업을 확인했습니다')); fireEvent.click(screen.getByRole('button', { name: '후보 변경 커밋' }));
  await screen.findAllByText('reply lost'); const original = fetcher.mock.calls.find(call => call[1]); expect(JSON.parse(original![1]!.body as string)).toMatchObject({ paths: [], candidateVersion: 'version', message: 'resolve to target' });
  first.unmount(); render(<CandidateEditing workId="a" candidateId="c" dirty={false} onChanged={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '저장된 요청 재확인' }));
  await waitFor(() => expect(fetcher.mock.calls.filter(call => call[1])).toHaveLength(2));
  expect(fetcher.mock.calls.filter(call => call[1])[1]).toEqual(original);
});
it('reserves only on an explicit click with heads selected from the preview', async () => {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, json: async () => url.endsWith('reservation-preview') ? { workHead: 'aaa', sourceBranch: 'main', sourceHead: 'bbb', reviewedVersion: 'review', branches: [{ name: 'main', commit: 'bbb' }] } : init ? { status: 'queued' } : { requests: [], active: null } })); vi.stubGlobal('fetch', fetcher);
  render(<WorkIntegration workId="a" />);
  await screen.findByRole('option', { name: 'main' });
  expect(fetcher.mock.calls.filter(call => call[1])).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('대상 브랜치'), { target: { value: 'main' } });
  fireEvent.click(screen.getByLabelText('표시된 기준과 전체 파일 작업을 확인했습니다'));
  fireEvent.click(screen.getByRole('button', { name: '통합 예약' }));
  await waitFor(() => expect(fetcher.mock.calls.filter(call => call[1])).toHaveLength(1));
  expect(JSON.parse(fetcher.mock.calls.find(call => call[1])![1]!.body as string)).toMatchObject({ expectedWorkHead: 'aaa', expectedTargetHead: 'bbb', reviewedVersion: 'review', targetBranch: 'main', confirmed: true });
});
it('shows a persisted request key while an explicit reservation is still waiting for its response', async () => {
  let finish!: (value: unknown) => void;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => init ? new Promise(resolve => { finish = resolve; }) : { ok: true, json: async () => url.endsWith('reservation-preview') ? { workHead: 'aaa', sourceBranch: 'main', sourceHead: 'bbb', reviewedVersion: 'review', branches: [{ name: 'main', commit: 'bbb' }] } : { requests: [], active: null } }); vi.stubGlobal('fetch', fetcher);
  render(<WorkIntegration workId="a" />); await screen.findByRole('option', { name: 'main' }); fireEvent.change(screen.getByLabelText('대상 브랜치'), { target: { value: 'main' } }); fireEvent.click(screen.getByLabelText('표시된 기준과 전체 파일 작업을 확인했습니다')); fireEvent.click(screen.getByRole('button', { name: '통합 예약' }));
  await screen.findByText('요청 저장됨·응답 확인 중'); expect(screen.getByText(String(readMutation('integration:a')?.body.requestKey))).toBeVisible(); expect(fetcher.mock.calls.filter(call => call[1])).toHaveLength(1);
  await act(async () => finish({ ok: true, json: async () => ({ status: 'queued' }) }));
});
