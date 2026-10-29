import { fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/render';
import { WorkspaceSettings } from './WorkspaceSettings';

const initial = { version: 0, profileId: 'profile', source: 'unset', path: null, managedPath: null, confirmed: false, editable: true, available: false, freeBytes: null };
afterEach(() => { vi.unstubAllGlobals(); });
it('검사와 경로 확인 전 저장을 막고 경로 편집 시 검사를 무효화한다', async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => ({ ok: true, json: async () => init?.method === 'POST' ? { token: 'check', version: 0, path: 'C:\\업무 공간', managedPath: 'C:\\업무 공간\\openspecboard-profile' } : init?.method === 'PUT' ? { ...initial, path: 'C:\\업무 공간', source: 'saved', confirmed: true, available: true, version: 1 } : initial }));
  vi.stubGlobal('fetch', fetch); render(<WorkspaceSettings />);
  const path = await screen.findByLabelText('저장 위치');
  const save = screen.getByRole('button', { name: '확인한 위치 저장' });
  expect(save).toBeDisabled();
  fireEvent.change(path, { target: { value: 'C:\\업무 공간' } });
  fireEvent.click(screen.getByRole('button', { name: '경로 검사' }));
  await screen.findByText('C:\\업무 공간\\openspecboard-profile');
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByLabelText('위 경로와 관리 폴더 생성을 확인했습니다'));
  expect(save).not.toBeDisabled();
  fireEvent.change(path, { target: { value: 'C:\\다른 위치' } });
  expect(save).toBeDisabled();
  expect(screen.queryByLabelText('위 경로와 관리 폴더 생성을 확인했습니다')).not.toBeInTheDocument();
});
it('다른 창의 충돌을 표시하고 새 설정 조회 후에도 초안을 보존한다', async () => {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => ({ ok: init?.method !== 'PUT', status: init?.method === 'PUT' ? 409 : 200, json: async () => init?.method === 'PUT' ? { message: '다른 창에서 설정이 변경되었습니다' } : init?.method === 'POST' ? { token: 'check', version: 0, path: 'C:\\초안', managedPath: 'C:\\초안\\profile' } : initial }));
  vi.stubGlobal('fetch', fetch); render(<WorkspaceSettings />);
  const path = await screen.findByLabelText('저장 위치');
  fireEvent.change(path, { target: { value: 'C:\\초안' } });
  fireEvent.click(screen.getByRole('button', { name: '경로 검사' }));
  fireEvent.click(await screen.findByLabelText('위 경로와 관리 폴더 생성을 확인했습니다'));
  fireEvent.click(screen.getByRole('button', { name: '확인한 위치 저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('다른 창에서 설정이 변경되었습니다');
  expect(path).toHaveValue('C:\\초안');
  fireEvent.click(screen.getByRole('button', { name: '최신 설정 조회 · 초안 유지' }));
  expect(path).toHaveValue('C:\\초안');
});
it('환경 고정 출처와 호스트 경로를 영어로 표시하고 경로 편집을 막는다', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ...initial, source: 'environment', path: 'D:\\host', editable: false }) })));
  render(<WorkspaceSettings />, { locale: 'en' });
  expect(await screen.findByLabelText('Storage location')).toBeDisabled();
  expect(screen.getByText('Environment · WORKSPACE_ROOT')).toBeInTheDocument();
  expect(screen.getByText(/Paths refer to the host running/)).toBeInTheDocument();
});
it('데스크톱 폴더 선택 취소는 초안을 유지하고 선택 결과는 재검사한다', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => initial })));
  const chooseFolder = vi.fn().mockResolvedValueOnce({ cancelled: true }).mockResolvedValueOnce({ cancelled: false, path: 'D:\\호스트 폴더' });
  vi.stubGlobal('desktopWorkspace', { chooseFolder });
  render(<WorkspaceSettings />);
  const path = await screen.findByLabelText('저장 위치'); fireEvent.change(path, { target: { value: 'C:\\초안' } });
  fireEvent.click(screen.getByRole('button', { name: '폴더 선택' }));
  await vi.waitFor(() => expect(chooseFolder).toHaveBeenCalledTimes(1));
  expect(path).toHaveValue('C:\\초안');
  await vi.waitFor(() => expect(screen.getByRole('button', { name: '폴더 선택' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: '폴더 선택' }));
  await vi.waitFor(() => expect(path).toHaveValue('D:\\호스트 폴더'));
  expect(screen.getByRole('button', { name: '확인한 위치 저장' })).toBeDisabled();
});

it('용량 정책 기본값과 저장값을 표시하고 충돌 후 정책 초안을 보존한다', async () => {
  const policy = { maxActiveWorks: 3, minimumFreeBytes: 5 * 1024 ** 3, retentionDays: 14 };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => ({ ok: init?.method !== 'PUT', json: async () => init?.method === 'PUT' ? { message: '정책 충돌' } : { ...initial, policy } }));
  vi.stubGlobal('fetch', fetch); render(<WorkspaceSettings />);
  const count = await screen.findByLabelText('동시 활성 업무 수'); expect(count).toHaveValue(3);
  expect(screen.getByLabelText('최소 잔여 용량 (GiB)')).toHaveValue(5); expect(screen.getByLabelText('자료 보존 제안 기간 (일)')).toHaveValue(14);
  fireEvent.change(count, { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: '용량 정책 저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('정책 충돌');
  expect(count).toHaveValue(2);
  fireEvent.click(screen.getByRole('button', { name: '최신 설정 조회 · 초안 유지' })); expect(count).toHaveValue(2);
  expect(fetch).toHaveBeenCalledWith('/api/workspace-settings/policy', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ version: 0, policy: { ...policy, maxActiveWorks: 2 } }) }));
});

it('저장된 정책을 불러와 사용자가 바꾼 값으로 저장한다', async () => {
  const policy = { maxActiveWorks: 6, minimumFreeBytes: 8 * 1024 ** 3, retentionDays: 30 };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => ({ ok: true, json: async () => ({ ...initial, version: init?.method === 'PUT' ? 1 : 0, policy: init?.method === 'PUT' ? { ...policy, maxActiveWorks: 4 } : policy }) }));
  vi.stubGlobal('fetch', fetch); render(<WorkspaceSettings />);
  const count = await screen.findByLabelText('동시 활성 업무 수'); expect(count).toHaveValue(6);
  expect(screen.getByLabelText('최소 잔여 용량 (GiB)')).toHaveValue(8); expect(screen.getByLabelText('자료 보존 제안 기간 (일)')).toHaveValue(30);
  fireEvent.change(count, { target: { value: '4' } }); fireEvent.click(screen.getByRole('button', { name: '용량 정책 저장' }));
  await vi.waitFor(() => expect(screen.getByRole('button', { name: '용량 정책 저장' })).not.toBeDisabled());
  expect(fetch).toHaveBeenCalledWith('/api/workspace-settings/policy', expect.objectContaining({ body: JSON.stringify({ version: 0, policy: { ...policy, maxActiveWorks: 4 } }) }));
});
