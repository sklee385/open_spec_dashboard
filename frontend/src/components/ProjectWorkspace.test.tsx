import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { ProjectWorkspace } from './ProjectWorkspace';
const workspaces = [{ id: 'work/one', sourceId: 'demo', changeName: 'feature', executionPath: 'D:/isolated', phase: 'implementation' }, { id: 'wrong', sourceId: 'other', changeName: 'other', executionPath: 'D:/other', phase: 'implementation' }];

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
const original = '{ "z": 1, "a": 2 }\r\n';
function mockApi(failSave = false) {
  const mock = vi.fn(async (url: string, init?: RequestInit): Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }> => {
    let body: unknown = {};
    if (url.includes('/tree')) body = { entries: [{ name: 'a.json', path: 'a.json', kind: 'file', version: 'v1' }, { name: 'b.txt', path: 'b.txt', kind: 'file' }], nextCursor: null };
    if (url.includes('/git/status')) body = { available: true, branch: 'main', head: 'abc', token: 't', entries: [], remotes: [], ahead: 0, behind: 0, progress: null };
    if (url.includes('/git/branches')) body = { branches: [] };
    if (url.includes('/git/log')) body = { commits: [], nextCursor: null };
    if (url.includes('/file')) body = { path: 'a.json', content: original, version: 'v1', size: 30, encoding: 'utf8', newline: 'crlf', bom: false, editable: true };
    if (init?.method === 'PUT' && failSave) return { ok: false, status: 409, json: async () => ({ error: 'version-conflict', latest: { content: 'external', version: 'v2' } }) };
    return { ok: true, json: async () => body };
  });
  vi.stubGlobal('fetch', mock); return mock;
}
it('shows exact JSON source without formatting, enters edit explicitly and preserves CRLF on save', async () => {
  const mock = mockApi(); render(<ProjectWorkspace sourceId="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'a.json' }));
  expect(await screen.findByTestId('project-source')).toHaveTextContent('{ "z": 1, "a": 2 }');
  expect(screen.queryByRole('textbox', { name: '파일 내용' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '편집' }));
  fireEvent.change(screen.getByRole('textbox', { name: '파일 내용' }), { target: { value: '{ "z": 3 }\n' } });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(mock.mock.calls.some(([, init]) => init?.method === 'PUT' && JSON.parse(String(init.body)).content === '{ "z": 3 }\r\n')).toBe(true));
});
it('keeps draft and blocks navigation when save fails, with latest content comparison', async () => {
  mockApi(true); render(<ProjectWorkspace sourceId="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'a.json' }));
  fireEvent.click(await screen.findByRole('button', { name: '편집' }));
  fireEvent.change(screen.getByRole('textbox', { name: '파일 내용' }), { target: { value: 'my draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'b.txt' }));
  fireEvent.click(await screen.findByRole('button', { name: '저장 후 이동' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('version-conflict');
  expect(screen.getByRole('textbox', { name: '파일 내용' })).toHaveValue('my draft');
  expect(screen.getAllByText('external').some(element => element.tagName === 'PRE')).toBe(true);
});
it('prompts for a project and localizes empty state in English', () => {
  render(<ProjectWorkspace sourceId={null} />, { locale: 'en' });
  expect(screen.getByText('Choose a project to browse source and Git.')).toBeVisible();
});
it('discards late file responses from the previous project', async () => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  let finish: (value: unknown) => void = () => {};
  mock.mockImplementation((url, init) => url.includes('/demo/file') ? new Promise(resolve => { finish = resolve as typeof finish; }) : originalImplementation(url, init));
  const view = render(<ProjectWorkspace sourceId="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'a.json' }));
  view.rerender(<ProjectWorkspace sourceId="other" />);
  await act(async () => finish({ ok: true, json: async () => ({ path: 'stale.txt', content: 'stale secret', version: 'v', editable: true }) }));
  expect(screen.queryByText('stale secret')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'stale.txt' })).toBeNull();
});
it('shows partially staged paths in both groups and deduplicates operation clicks', async () => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  mock.mockImplementation(async (url, init) => {
    if (url.includes('/git/status')) return { ok: true, json: async () => ({ available: true, branch: 'main', head: 'abc', token: 'fresh-token', entries: [{ path: 'both.ts', index: 'M', worktree: 'M' }], remotes: [], progress: null }) };
    if (url.endsWith('/git/operations')) return { ok: true, json: async () => ({ id: 'op1', kind: 'stage', status: 'running' }) };
    if (url.endsWith('/git/operations/op1')) return new Promise(() => {});
    return originalImplementation(url, init);
  });
  render(<ProjectWorkspace sourceId="demo" />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'both.ts' })).toHaveLength(2));
  const stage = screen.getByRole('button', { name: '파일 스테이징' }); fireEvent.click(stage); fireEvent.click(stage);
  await waitFor(() => expect(mock.mock.calls.filter(([url]) => url.endsWith('/git/operations'))).toHaveLength(1));
  const body = JSON.parse(String(mock.mock.calls.find(([url]) => url.endsWith('/git/operations'))![1]?.body));
  expect(body).toMatchObject({ kind: 'stage', paths: ['both.ts'], token: 'fresh-token' }); expect(body.requestKey).toBeTruthy();
});
it('opens historical commit content read only without reading the working file', async () => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  mock.mockImplementation(async (url, init) => {
    if (url.includes('/git/log')) return { ok: true, json: async () => ({ commits: [{ hash: 'abc12345', author: 'Author', date: '2026-10-25T00:00:00Z', message: 'old commit' }], nextCursor: null }) };
    if (url.includes('/git/commits/abc12345/file')) return { ok: true, json: async () => ({ path: 'old.ts', content: 'original historical source', base: 'parent' }) };
    if (url.includes('/git/commits/abc12345')) return { ok: true, json: async () => ({ hash: 'abc12345', message: 'old commit', author: 'Author', date: '2026-10-25T00:00:00Z', parents: [], base: 'empty-tree', files: [{ path: 'old.ts', status: 'D' }] }) };
    return originalImplementation(url, init);
  });
  render(<ProjectWorkspace sourceId="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'abc12345 old commit' }));
  fireEvent.click(await screen.findByRole('button', { name: '커밋 시점 파일 · 읽기 전용' }));
  expect(await screen.findByText('original historical source')).toBeVisible();
  expect(screen.getByText(/삭제 파일 · 부모 버전/)).toBeVisible();
  expect(screen.queryByRole('button', { name: '편집' })).toBeNull();
  expect(mock.mock.calls.some(([url]) => /\/demo\/file\?/.test(url))).toBe(false);
});
it('confirms file deletion with version and clears the opened file after success', async () => {
  const mock = mockApi(); render(<ProjectWorkspace sourceId="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'a.json' }));
  fireEvent.click(await screen.findByRole('button', { name: '파일 삭제' }));
  const dialog = screen.getByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: '확인' }));
  await waitFor(() => expect(mock.mock.calls.some(([, init]) => init?.method === 'DELETE' && JSON.parse(String(init.body)).version === 'v1')).toBe(true));
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'a.json' })).toBeNull());
});
it.each(['push', 'continue-pull', 'abort-pull'])('lets the user inspect an uncertain historical %s operation without repeating it', async kind => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  localStorage.setItem('project-operation:demo', 'uncertain-id');
  mock.mockImplementation(async (url, init) => {
    if (url.endsWith('/reconcile')) return { ok: true, json: async () => ({ operation: { id: 'uncertain-id', kind, status: 'uncertain', reviewedAt: 'now' }, evidence: { remoteHead: 'abc' }, status: { available: true, branch: 'main', entries: [], token: 'new-token', remotes: [], progress: null } }) };
    if (url.endsWith('/operations/uncertain-id')) return { ok: true, json: async () => ({ id: 'uncertain-id', kind, status: 'uncertain' }) };
    return originalImplementation(url, init);
  });
  render(<ProjectWorkspace sourceId="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: '실제 Git·원격 상태 확인' }));
  expect(await screen.findByText(/remoteHead/)).toBeVisible();
  expect(localStorage.getItem('project-operation:demo')).toBe('uncertain-id');
  expect(JSON.parse(localStorage.getItem('project-operation-record:demo')!)).toMatchObject({ id: 'uncertain-id', kind, status: 'uncertain', reviewedAt: 'now' });
  expect(mock.mock.calls.some(([url, init]) => url.endsWith('/reconcile') && JSON.parse(String(init?.body)).confirmed === true)).toBe(true);
  expect(mock.mock.calls.some(([url]) => url.endsWith('/git/operations'))).toBe(false);
});
it('blocks a commit preview containing excluded index entries', async () => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  mock.mockImplementation(async (url, init) => url.includes('/git/status') ? { ok: true, json: async () => ({ available: true, branch: 'main', token: 't', remotes: [], entries: [{ path: 'visible.ts', index: 'M', worktree: '.' }], protectedIndex: true, hiddenChanges: 1 }) } : originalImplementation(url, init));
  render(<ProjectWorkspace sourceId="demo" />);
  fireEvent.change(await screen.findByRole('textbox', { name: '커밋 메시지' }), { target: { value: 'commit all' } });
  expect(screen.getByRole('button', { name: '인덱스 전체 커밋' })).toBeDisabled();
  expect(screen.getByText('제외된 인덱스 항목이 있어 전체 커밋 미리보기가 불완전합니다. 외부에서 정리한 뒤 새로고침하세요.')).toBeVisible();
});
it('refreshes the open file while preserving an unsaved draft against external changes', async () => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!; let changed = false;
  mock.mockImplementation(async (url, init) => url.includes('/file?') && changed ? { ok: true, json: async () => ({ path: 'a.json', content: 'new disk content', version: 'v2', size: 16, encoding: 'utf8', newline: 'lf', editable: true }) } : originalImplementation(url, init));
  render(<ProjectWorkspace sourceId="demo" />);
  fireEvent.click(await screen.findByRole('button', { name: 'a.json' })); fireEvent.click(await screen.findByRole('button', { name: '편집' }));
  fireEvent.change(screen.getByRole('textbox', { name: '파일 내용' }), { target: { value: 'keep my draft' } }); changed = true;
  fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
  expect(await screen.findByRole('heading', { name: '디스크의 최신 파일' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: '파일 내용' })).toHaveValue('keep my draft');
});
it('retains mixed original line endings while editing a line', async () => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  mock.mockImplementation(async (url, init) => url.includes('/file?') ? { ok: true, json: async () => ({ path: 'a.json', content: 'one\r\ntwo\nthree\r', version: 'v1', size: 17, encoding: 'utf8', newline: 'mixed', editable: true }) } : originalImplementation(url, init));
  render(<ProjectWorkspace sourceId="demo" />); fireEvent.click(await screen.findByRole('button', { name: 'a.json' })); fireEvent.click(await screen.findByRole('button', { name: '편집' }));
  fireEvent.change(screen.getByRole('textbox', { name: '파일 내용' }), { target: { value: 'ONE\ntwo\nthree\n' } }); fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(mock.mock.calls.some(([, init]) => init?.method === 'PUT' && JSON.parse(String(init.body)).content === 'ONE\r\ntwo\nthree\r')).toBe(true));
});
it('lazily expands a folder while retaining its siblings in the file tree', async () => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  mock.mockImplementation(async (url, init) => url.includes('/tree') ? { ok: true, json: async () => ({ entries: url.includes('path=src') ? [{ path: 'src/child.ts', name: 'child.ts', kind: 'file' }] : [{ path: 'src', name: 'src', kind: 'directory', version: 'folder-v' }, { path: 'root.ts', name: 'root.ts', kind: 'file' }], nextCursor: null }) } : originalImplementation(url, init));
  render(<ProjectWorkspace sourceId="demo" />); fireEvent.click(await screen.findByRole('button', { name: 'src' }));
  expect(await screen.findByRole('button', { name: 'child.ts' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'root.ts' })).toBeVisible();
});
it('loads directory identity on demand before moving it', async () => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  mock.mockImplementation(async (url, init) => {
    if (url.includes('/entry?')) return { ok: true, json: async () => ({ path: 'src', name: 'src', kind: 'directory', version: 'directory-version' }) };
    if (url.includes('/tree')) return { ok: true, json: async () => ({ entries: url.includes('path=src') ? [] : [{ path: 'src', name: 'src', kind: 'directory' }], nextCursor: null }) };
    return originalImplementation(url, init);
  });
  render(<ProjectWorkspace sourceId="demo" />); fireEvent.click(await screen.findByRole('button', { name: 'src' }));
  fireEvent.click(screen.getByRole('button', { name: '이름 변경·이동' }));
  fireEvent.change(screen.getByRole('textbox', { name: '프로젝트 상대 경로' }), { target: { value: 'lib' } }); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '확인' }));
  await waitFor(() => expect(mock.mock.calls.some(([url, init]) => url.endsWith('/entries/move') && JSON.parse(String(init?.body)).version === 'directory-version')).toBe(true));
});
it.each(['connection', 'gateway'])('retains a lost-response operation warning after reopening the workspace (%s)', async failure => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  mock.mockImplementation(async (url, init) => {
    if (url.endsWith('/git/operations')) {
      if (failure === 'gateway') return { ok: false, status: 503, json: async () => ({ error: 'upstream connection lost' }) };
      throw new Error('connection lost');
    }
    if (url.includes('/git/status')) return { ok: true, json: async () => ({ available: true, branch: 'main', head: 'abc', token: 't', entries: [{ path: 'a.ts', index: '.', worktree: 'M' }], remotes: [], progress: null }) };
    return originalImplementation(url, init);
  });
  const view = render(<ProjectWorkspace sourceId="demo" />); fireEvent.click(await screen.findByRole('button', { name: '파일 스테이징' }));
  await screen.findByText(/실행 결과가 불확실합니다/); view.unmount();
  render(<ProjectWorkspace sourceId="demo" />);
  expect(await screen.findByText(/실행 결과가 불확실합니다/)).toBeVisible();
  expect(mock.mock.calls.filter(([url]) => url.endsWith('/git/operations'))).toHaveLength(1);
});
it('guards changing between original and work space and keeps the scope when canceled', async () => {
  mockApi(); const onScope = vi.fn(); render(<ProjectWorkspace sourceId="demo" workspaces={workspaces} onWorkScopeChange={onScope} />);
  fireEvent.click(await screen.findByRole('button', { name: 'a.json' })); fireEvent.click(await screen.findByRole('button', { name: '편집' }));
  fireEvent.change(screen.getByRole('textbox', { name: '파일 내용' }), { target: { value: 'unsaved' } });
  fireEvent.change(screen.getByRole('combobox', { name: '소스 작업 위치' }), { target: { value: 'work/one' } });
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '취소' }));
  expect(onScope).not.toHaveBeenCalled(); expect(screen.getByRole('combobox', { name: '소스 작업 위치' })).toHaveValue('');
  expect(screen.queryByRole('option', { name: /other/ })).toBeNull();
  fireEvent.change(screen.getByRole('combobox', { name: '소스 작업 위치' }), { target: { value: 'work/one' } }); fireEvent.click(await screen.findByRole('button', { name: '변경 버리기' }));
  await waitFor(() => expect(onScope).toHaveBeenCalledWith('work/one'));
});
it('sends the work ID with read and mutation APIs and ignores old scope responses', async () => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  let finish: (value: unknown) => void = () => {};
  mock.mockImplementation((url, init) => url.includes('/file?') && !url.includes('workId=') ? new Promise(resolve => { finish = resolve as typeof finish; }) : originalImplementation(url, init));
  const view = render(<ProjectWorkspace sourceId="demo" workspaces={workspaces} />); fireEvent.click(await screen.findByRole('button', { name: 'a.json' }));
  view.rerender(<ProjectWorkspace sourceId="demo" workId="work/one" workspaces={workspaces} />);
  await act(async () => finish({ ok: true, json: async () => ({ path: 'oldscope.ts', content: 'old scope text', version: 'v1', editable: true }) }));
  expect(screen.queryByText('old scope text')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'a.json' })); fireEvent.click(await screen.findByRole('button', { name: '편집' }));
  fireEvent.change(screen.getByRole('textbox', { name: '파일 내용' }), { target: { value: 'isolated code' } }); fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(mock.mock.calls.some(([url, init]) => init?.method === 'PUT' && new URL(url, 'http://test').searchParams.get('workId') === 'work/one')).toBe(true));
  expect(mock.mock.calls.filter(([url]) => url.includes('workId=')).some(([url]) => url.includes('/git/status'))).toBe(true);
  expect(screen.getByText(/업무 화면에서 원본에 반영한 뒤 프로젝트 원본에서 커밋하세요/)).toBeVisible();
});
it('keeps project files editable when only the Git root boundary is blocked', async () => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  mock.mockImplementation(async (url, init) => url.includes('/git/status') ? { ok: true, json: async () => ({ available: true, blocked: 'Git root mismatch', branch: 'main', head: 'abc', token: 't', entries: [], remotes: [], progress: null }) } : originalImplementation(url, init));
  render(<ProjectWorkspace sourceId="demo" />); fireEvent.click(await screen.findByRole('button', { name: 'a.json' }));
  expect(await screen.findByRole('button', { name: '편집' })).toBeEnabled();
});
it('shows the actual safe remote destinations before confirming a push', async () => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  mock.mockImplementation(async (url, init) => url.includes('/git/status') ? { ok: true, json: async () => ({ available: true, branch: 'main', head: 'abc', upstream: 'origin/main', remote: 'origin', destinations: ['https://git.example/team/project.git'], token: 't', entries: [], remotes: ['origin'], outgoing: [{ hash: 'abc', message: 'outgoing commit' }], progress: null }) } : originalImplementation(url, init));
  render(<ProjectWorkspace sourceId="demo" />); fireEvent.click(await screen.findByRole('button', { name: '전송 (push)' }));
  expect(within(screen.getByRole('dialog')).getByText('https://git.example/team/project.git')).toBeVisible();
  expect(mock.mock.calls.some(([url]) => url.endsWith('/git/operations'))).toBe(false);
});
it.each([
  { kind: 'merge', owned: false },
  { kind: 'rebase', owned: false },
  { kind: 'rebase', owned: true },
  null,
])('locks all Git mutations while leaving file editing available during cleanup (%j)', async progress => {
  const mock = mockApi(); const originalImplementation = mock.getMockImplementation()!;
  mock.mockImplementation(async (url, init) => url.includes('/git/status') ? { ok: true, json: async () => ({ available: true, branch: 'main', head: 'abc', upstream: 'origin/main', token: 't', remotes: ['origin'], entries: [
    { path: 'staged.ts', index: 'M', worktree: '.' },
    { path: 'unstaged.ts', index: '.', worktree: 'M' },
    ...(progress ? [] : [{ path: 'conflict.ts', index: 'U', worktree: 'U', conflicted: true }]),
  ], progress }) } : originalImplementation(url, init));
  render(<ProjectWorkspace sourceId="demo" />);
  expect(await screen.findByText('merge/rebase 또는 충돌 인덱스가 남아 있습니다. 외부 Git 도구에서 완료하거나 중단한 뒤 새로고침하세요.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'pull 계속' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'pull 중단' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: '커밋 메시지' }), { target: { value: 'commit' } });
  fireEvent.change(screen.getByRole('textbox', { name: '새 브랜치 이름' }), { target: { value: 'feature' } });
  for (const name of ['파일 스테이징', '스테이징 해제', '인덱스 전체 커밋', '브랜치 생성', '가져오기 (fetch)', '동기화 (pull)', '전송 (push)']) {
    for (const button of screen.getAllByRole('button', { name })) expect(button).toBeDisabled();
  }
  expect(screen.getByRole('combobox', { name: '브랜치 전환' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '파일 생성' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '폴더 생성' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'a.json' }));
  fireEvent.click(await screen.findByRole('button', { name: '편집' }));
  fireEvent.change(screen.getByRole('textbox', { name: '파일 내용' }), { target: { value: 'edited during cleanup' } });
  expect(screen.getByRole('button', { name: '저장' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '파일 삭제' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '이름 변경·이동' })).toBeEnabled();
  expect(mock.mock.calls.some(([url]) => url.endsWith('/git/operations'))).toBe(false);
});
it.each(['ko', 'en'] as const)('explains fast-forward-only pull and divergence recovery (%s)', async locale => {
  mockApi(); render(<ProjectWorkspace sourceId="demo" />, { locale });
  expect(await screen.findByText(locale === 'ko'
    ? 'pull은 fast-forward만 허용하며 merge/rebase를 시작하지 않습니다. 이력이 갈라져 실패하면 외부 Git 도구에서 정리한 뒤 새로고침하세요.'
    : 'Pull only allows fast-forward updates and never starts a merge or rebase. If histories diverge, resolve them in an external Git tool, then refresh.')).toBeVisible();
});
