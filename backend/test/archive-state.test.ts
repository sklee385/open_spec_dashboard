import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore, type Work } from '../src/work/store';
import { WorkService } from '../src/work/work.service';
import { changeDetail } from '../src/legacy/parser';

let store: WorkStore;
afterEach(() => { store?.onApplicationShutdown(); delete process.env.DATA_DIR; });
function fixture(state = 'idle') {
  const root = mkdtempSync(join(tmpdir(), 'archive-state-'));
  process.env.DATA_DIR = join(root, 'data'); store = new WorkStore();
  const source = { id: 'demo', path: join(root, 'openspec'), valid: true };
  const archived = join(source.path, 'changes/archive/2026-10-26-feature');
  mkdirSync(archived, { recursive: true });
  writeFileSync(join(archived, 'tasks.md'), '- [x] implemented\n');
  writeFileSync(join(archived, 'proposal.md'), '# Saved proposal\n');
  const work: Work = { id: 'work', requestKey: 'request', sourceId: 'demo', projectPath: root, changeName: 'feature', ideaIds: ['demo/idea'], phase: 'planning', state, threadId: 'same-thread', reviewedVersion: null, createdAt: '', updatedAt: '' };
  store.save(work);
  const cli = { run: vi.fn() };
  const legacy = { source: () => source, sources: () => [source], splitId: (id: string) => id.split('/'), detail: () => changeDetail(source.path, 'demo', 'feature'), updates: { next: vi.fn() } };
  const service = Reflect.construct(WorkService, [store, legacy, null, cli, null, null, null, null]) as WorkService;
  return { service, work, archived, source, cli };
}
it('외부 보관된 업무를 조회하면 같은 대화와 문서를 보존하여 보관 상태를 복구한다', () => {
  const { service } = fixture();
  expect(service.get('work')).toMatchObject({ phase: 'archived', archiveName: '2026-10-26-feature', threadId: 'same-thread' });
  expect(service.document('work', 'proposal.md').content).toContain('Saved proposal');
  expect(store.get('work')?.phase).toBe('archived');
});
it('보관 카드 재진입 시 원본 아이디어를 다시 이동하지 않는다', async () => {
  const { service } = fixture();
  expect(await service.create({ sourceId: 'demo', changeName: 'feature', requestKey: 'another' })).toMatchObject({ id: 'work', phase: 'archived' });
});
it('이미 보관된 업무의 보관 재시도는 CLI를 다시 실행하지 않는다', async () => {
  const { service, cli } = fixture();
  expect(await service.action('work', { action: 'archive' })).toMatchObject({ phase: 'archived' });
  expect(cli.run).not.toHaveBeenCalled();
});
it('실행 중인 업무는 파일 이동만으로 보관 상태로 덮어쓰지 않는다', () => {
  const { service } = fixture('running');
  expect(service.get('work').phase).toBe('planning');
});
it('동일 이름의 활성 변경이 있으면 과거 보관 기록으로 전환하지 않는다', () => {
  const { service, source } = fixture();
  mkdirSync(join(source.path, 'changes/feature'));
  expect(service.get('work').phase).toBe('planning');
});
it('목록도 보관 상태를 복구하고 반복 조회에서 이벤트를 중복하지 않는다', () => {
  const { service } = fixture();
  expect(service.list()[0].phase).toBe('archived');
  service.list(); service.get('work');
  expect(store.events('work').filter(event => event.type === 'archive-reconciled')).toHaveLength(1);
});
it('질문 응답 대기 중에는 외부 보관 파일만으로 업무를 종결하지 않는다', () => {
  const { service } = fixture();
  store.record('question', 'work', 'question', { kind: 'input', status: 'pending' });
  expect(service.get('work').phase).toBe('planning');
});
it('여러 날짜에 같은 이름을 보관했으면 임의의 기록을 선택하지 않는다', () => {
  const { service, source } = fixture();
  mkdirSync(join(source.path, 'changes/archive/2026-10-25-feature'));
  expect(service.get('work').phase).toBe('planning');
});
it('빈 보관 폴더만 있으면 보관 성공으로 간주하지 않는다', () => {
  const { service, archived } = fixture();
  unlinkSync(join(archived, 'tasks.md')); unlinkSync(join(archived, 'proposal.md'));
  expect(service.get('work').phase).toBe('planning');
});
it('종료를 확인하지 못해 복구가 필요한 실행 상태와 오류를 보존한다', () => {
  const { service, work } = fixture('recovery-required');
  store.save({ ...work, errorCode: 'termination-unconfirmed' });
  expect(service.get('work')).toMatchObject({ phase: 'planning', state: 'recovery-required', errorCode: 'termination-unconfirmed' });
});
