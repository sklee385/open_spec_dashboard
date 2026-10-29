import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkStore } from '../src/work/store';
import { CodexService } from '../src/codex/codex.service';
import { CodexClient, CodexRpcRejectedError } from '../src/codex/client';
import { desktopHealth } from '../src/desktop/health';
import { DesktopLifecycle } from '../src/desktop/lifecycle';
import { WorkRecovery } from '../src/work/recovery';
import { FileResults } from '../src/work/file-results';

let store: WorkStore, service: CodexService, root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-recovery-')); process.env.DATA_DIR = join(root, 'data');
  mkdirSync(join(root, 'openspec/changes/test'), { recursive: true });
  writeFileSync(join(root, 'openspec/changes/test/tasks.md'), '- [x] done\n- [ ] pending');
  store = new WorkStore();
  store.save({ id: 'w', sourceId: 's', projectPath: root, changeName: 'test', requestKey: 'w', ideaIds: [], phase: 'planning', state: 'idle', threadId: 'old', turnId: 'known-turn', reviewedVersion: null, createdAt: '', updatedAt: '' });
  service = new CodexService(store, { updates: { next() {} }, source: () => ({ path: join(root, 'openspec') }) } as any, { bridge: { disconnect() {}, cancel() {} } } as any, { cancel: async () => {} } as any);
  vi.spyOn(service.client, 'ready').mockResolvedValue();
});
afterEach(async () => { vi.useRealTimers(); await service.onModuleDestroy(); store.onApplicationShutdown(); delete process.env.DATA_DIR; vi.restoreAllMocks(); });
it('creates one durable replacement without replaying instructions and ignores old notifications', async () => {
  store.event('w', 'user-message', { text: 'preserved goal' });
  const rpc = vi.spyOn(service.client, 'rpc').mockImplementation(async method => method === 'thread/read' ? { thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed' }] } } : { thread: { id: 'new' } });
  const result = await (service as any).recoverSession('w', { requestId: 'request-1' });
  expect(result).toMatchObject({ threadId: 'new', phase: 'planning', sessionRecovery: { status: 'completed', previousThreadId: 'old', newThreadId: 'new' } });
  await (service as any).recoverSession('w', { requestId: 'request-1' });
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['thread/read', 'thread/start', 'thread/name/set']);
  expect(rpc).toHaveBeenCalledWith('thread/name/set', { threadId: 'new', name: '복구 · test' });
  const context = store.records('w', 'session-recovery-context')[0];
  expect(JSON.stringify(context)).toContain('preserved goal'); expect(JSON.stringify(context)).toContain('pending');
  service.client.emit('notification', { method: 'turn/completed', params: { threadId: 'old', turn: { id: 'late', status: 'failed' } } });
  expect(store.get('w')?.state).toBe('idle');
  expect(store.events('w').some(event => event.type === 'previous-session-notification' && event.data.threadId === 'old')).toBe(true);
});
it.each(['rejected', 'timeout'])('retains the created thread as uncertain when durable name persistence is %s and allows explicit cancellation', async mode => {
  let workBeforeName: any, recoveryBeforeName: any;
  const rpc = vi.spyOn(service.client, 'rpc').mockImplementation(async method => {
    if (method === 'thread/read') return { thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed' }] } };
    if (method === 'thread/start') return { thread: { id: 'created-before-name' } };
    if (method === 'thread/name/set') {
      workBeforeName = store.get('w'); recoveryBeforeName = store.records('w', 'session-recovery')[0];
      throw mode === 'rejected' ? new CodexRpcRejectedError('name rejected', method) : new Error('name timeout');
    }
    throw new Error(`unexpected RPC ${method}`);
  });
  await expect(service.recoverSession('w', { requestId: 'name-failure' })).rejects.toThrow();
  expect(workBeforeName).toMatchObject({ threadId: 'old', sessionRecovery: { status: 'creating', newThreadId: 'created-before-name' } });
  expect(recoveryBeforeName).toMatchObject({ status: 'creating', newThreadId: 'created-before-name' });
  expect(store.get('w')).toMatchObject({ threadId: 'old', sessionRecovery: { status: 'uncertain', newThreadId: 'created-before-name' } });
  expect((await service.recoverSession('w', { requestId: 'name-failure' })).sessionRecovery).toMatchObject({ status: 'uncertain', newThreadId: 'created-before-name' });
  await expect(service.recoverSession('w', { requestId: 'different-request' })).rejects.toThrow();
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['thread/read', 'thread/start', 'thread/name/set']);
  vi.spyOn(CodexClient.prototype, 'ready').mockResolvedValue();
  const cancellationRpc = vi.spyOn(CodexClient.prototype, 'rpc').mockResolvedValue({ thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed' }] } });
  expect((await service.cancelSessionRecovery('w', { requestId: 'name-failure' })).sessionRecovery).toMatchObject({ status: 'abandoned', newThreadId: 'created-before-name' });
  expect(cancellationRpc.mock.calls.map(call => call[0])).toEqual(['thread/read']);
  expect(store.records('w', 'session-recovery-context')).toHaveLength(1);
});
it('prepares bounded read-only context and never creates a writable session for unknown execution', async () => {
  const work = store.get('w')!; work.state = 'recovery-required'; work.turnId = 'possibly-active'; store.save(work);
  const rpc = vi.spyOn(service.client, 'rpc');
  const result = await (service as any).recoverSession('w', { requestId: 'unknown' });
  expect(result.sessionRecovery.status).toBe('blocked'); expect(result.threadId).toBe('old');
  expect(store.records('w', 'session-recovery-context')).toHaveLength(1); expect(rpc).not.toHaveBeenCalled();
});
it('preserves uncertain creation across retries and service restart', async () => {
  const rpc = vi.spyOn(service.client, 'rpc').mockImplementation(async method => { if (method === 'thread/read') return { thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed' }] } }; throw new Error('timeout'); });
  await expect((service as any).recoverSession('w', { requestId: 'lost' })).rejects.toThrow();
  expect(store.get('w')?.sessionRecovery).toMatchObject({ status: 'uncertain' });
  await service.onModuleDestroy(); store.onApplicationShutdown();
  store = new WorkStore();
  service = new CodexService(store, { updates: { next() {} } } as any, {} as any, {} as any);
  await (service as any).recoverSession('w', { requestId: 'lost' });
  await expect((service as any).recoverSession('w', { requestId: 'different' })).rejects.toThrow();
  expect(rpc).toHaveBeenCalledTimes(2);
});
it('external writer rejection before a Board turn does not block shutdown after restart', async () => {
  vi.spyOn(service.client, 'rpc').mockRejectedValue(new CodexRpcRejectedError('already has an active writer', 'thread/resume'));
  await expect(service.reconnect('w')).rejects.toThrow();
  expect(desktopHealth(store).runtime(store.get('w')!)).toBe('inactive');
  expect(store.get('w')?.executionUnconfirmed).toBe(false);
  await service.onModuleDestroy(); store.onApplicationShutdown();
  store = new WorkStore();
  service = new CodexService(store, { updates: { next() {} } } as any, {} as any, {} as any);
  expect(desktopHealth(store).runtime(store.get('w')!)).toBe('inactive');
  expect(new DesktopLifecycle(store).status().idle).toBe(true);
});
it('separate works use separate connections', () => {
  expect((service as any).clientFor('w')).not.toBe((service as any).clientFor('another'));
});
it('allows a blocked request to be checked again only after explicit termination confirmation', async () => {
  const work = store.get('w')!; work.state = 'recovery-required'; store.save(work);
  const rpc = vi.spyOn(service.client, 'rpc').mockImplementation(async method => method === 'thread/read' ? { thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed' }] } } : { thread: { id: 'new' } });
  expect((await (service as any).recoverSession('w', { requestId: 'retry-blocked' })).sessionRecovery.status).toBe('blocked');
  const confirmed = store.get('w')!; confirmed.state = 'idle'; confirmed.executionUnconfirmed = false; store.save(confirmed);
  expect((await (service as any).recoverSession('w', { requestId: 'retry-blocked' })).sessionRecovery.status).toBe('completed');
  expect(rpc.mock.calls.filter(call => call[0] === 'thread/start')).toHaveLength(1);
});
it('rejects recovery of an old question into the replacement thread', async () => {
  const rpc = vi.spyOn(service.client, 'rpc');
  store.record('old-question', 'w', 'question', { status: 'expired', kind: 'input', params: { threadId: 'different-old', questions: [{ id: 'a' }] } });
  await expect(service.answer('w', { questionId: 'old-question', recover: true, answers: { a: { answers: ['yes'] } } })).rejects.toThrow();
  expect(store.records('w', 'question')[0].status).toBe('expired');
  expect(rpc).not.toHaveBeenCalled();
});
it('does not create a new session while a prior child agent may still be running', async () => {
  const rpc = vi.spyOn(service.client, 'rpc').mockResolvedValue({ thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed', items: [{ type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'] }] }] } });
  expect((await (service as any).recoverSession('w', { requestId: 'child' })).sessionRecovery.status).toBe('blocked');
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['thread/read']);
});
it('a disconnected work cannot mark another isolated connection unknown', () => {
  const work = { ...store.get('w')!, id: 'other', requestKey: 'other', changeName: 'other', threadId: 'other-thread', state: 'running', executionUnconfirmed: true }; store.save(work);
  const first = (service as any).clientFor('w'), second = (service as any).clientFor('other');
  (service as any).active.set('other', { token: Symbol(), generation: second.generation, turnId: 'other-turn', state: 'active' });
  first.emit('disconnected', 'lost first');
  expect(store.get('other')?.state).toBe('running'); expect(desktopHealth(store).runtime(store.get('other')!)).toBe('active');
});
it('does not create a writable replacement beside an unknown execution in the same folder', async () => {
  store.save({ ...store.get('w')!, id: 'other', requestKey: 'other', changeName: 'other', threadId: 'other-thread', state: 'recovery-required', executionUnconfirmed: true });
  const rpc = vi.spyOn(service.client, 'rpc').mockImplementation(async method => method === 'thread/read' ? { thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed' }] } } : { thread: { id: 'new' } });
  await expect((service as any).recoverSession('w', { requestId: 'shared-folder' })).rejects.toThrow();
  expect(rpc.mock.calls.some(call => call[0] === 'thread/start')).toBe(false);
});
it('does not send a fresh writable turn beside an unknown execution in the same folder', async () => {
  store.save({ ...store.get('w')!, id: 'other', requestKey: 'other', changeName: 'other', threadId: 'other-thread', state: 'recovery-required', executionUnconfirmed: true });
  const rpc = vi.spyOn(service.client, 'rpc').mockResolvedValue({ thread: { id: 'old' }, turn: { id: 'new-turn' } });
  await expect(service.send('w', 'new instruction')).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
it('preserves completed Board messages and uses native read-only history as reference context', async () => {
  store.event('w', 'item/completed', { threadId: 'old', turnId: 'known-turn', item: { id: 'completed-message', type: 'agentMessage', text: 'Completed-only decision' } });
  const rpc = vi.spyOn(service.client, 'rpc').mockImplementation(async method => method === 'thread/read' ? { thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed', items: [{ id: 'native-message', type: 'agentMessage', text: 'Native stored decision' }] }] } } : { thread: { id: 'new' } });
  await (service as any).recoverSession('w', { requestId: 'history' });
  const context = store.records('w', 'session-recovery-context')[0];
  expect(JSON.stringify(context)).toContain('Completed-only decision'); expect(JSON.stringify(context)).toContain('Native stored decision');
  expect(JSON.stringify(rpc.mock.calls.find(call => call[0] === 'thread/start')?.[1])).toContain('Native stored decision');
});
it('reconnect cannot clear unknown execution from parent termination while child ownership is unconfirmed', async () => {
  const work = store.get('w')!; work.state = 'recovery-required'; work.executionUnconfirmed = true; store.save(work);
  vi.spyOn(service.client, 'rpc').mockResolvedValue({ thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed', items: [{ type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'] }] }] } });
  await service.reconnect('w');
  expect(desktopHealth(store).runtime(store.get('w')!)).toBe('unknown');
  service.client.emit('notification', { method: 'turn/completed', params: { threadId: 'old', turn: { id: 'known-turn', status: 'completed' } } });
  expect(desktopHealth(store).runtime(store.get('w')!)).toBe('unknown');
  await expect(service.send('w', 'do not overwrite child work')).rejects.toThrow();
});
it('writer rejection preserves untransmitted queued instructions as blocked and allows normal app exit', async () => {
  let rejectResume!: (error: Error) => void;
  const waiting = new Promise((_resolve, reject) => { rejectResume = reject; });
  const rpc = vi.spyOn(service.client, 'rpc').mockImplementation(() => waiting);
  const sending = service.send('w', 'first explicit instruction').catch(error => error);
  await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
  expect(await service.send('w', 'preserve queued draft')).toMatchObject({ queued: true });
  store.record('pending', 'w', 'queued-message', { text: 'preserve pending draft', status: 'pending' });
  rejectResume(new CodexRpcRejectedError('already has an active writer', 'thread/resume'));
  expect(await sending).toBeInstanceOf(Error);
  expect(store.records('w', 'queued-message').map(record => record.status)).toEqual(['blocked', 'blocked']);
  expect(store.records('w', 'queued-message').map(record => record.text)).toContain('preserve queued draft');
  expect(new DesktopLifecycle(store).status().idle).toBe(true);
  expect(store.get('w')?.executionUnconfirmed).toBe(false);
});
it('writer rejection never erases dispatching or uncertain command evidence', async () => {
  store.record('dispatching', 'w', 'queued-message', { text: 'possibly sent', status: 'dispatching' });
  store.record('uncertain', 'w', 'queued-message', { text: 'result unknown', status: 'uncertain' });
  vi.spyOn(service.client, 'rpc').mockRejectedValue(new CodexRpcRejectedError('already has an active writer', 'thread/resume'));
  await expect(service.reconnect('w')).rejects.toThrow();
  expect(store.records('w', 'queued-message').map(record => record.status)).toEqual(['dispatching', 'uncertain']);
  expect(new DesktopLifecycle(store).status().idle).toBe(false);
});
it('explicit cancellation releases only the uncertain work connection and abandons its recovery after terminal evidence', async () => {
  vi.spyOn(service.client, 'rpc').mockImplementation(async method => { if (method === 'thread/read') return { thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed' }] } }; throw new Error('lost creation response'); });
  await expect(service.recoverSession('w', { requestId: 'cancel-me' })).rejects.toThrow();
  const old = service.client, close = vi.spyOn(old, 'close');
  vi.spyOn(CodexClient.prototype, 'ready').mockResolvedValue();
  const rpc = vi.spyOn(CodexClient.prototype, 'rpc').mockResolvedValue({ thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed' }] }, account: { type: 'chatgpt' } });
  const result = await (service as any).cancelSessionRecovery('w', { requestId: 'cancel-me' });
  expect(result).toMatchObject({ threadId: 'old', sessionRecovery: { status: 'abandoned' } });
  expect(close).toHaveBeenCalledTimes(1); expect(service.client).not.toBe(old);
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['thread/read']);
  expect((await service.status()).connected).toBe(true);
  expect(store.records('w', 'session-recovery-context')).toHaveLength(1);
  expect(store.records('w', 'session-recovery')[0].status).toBe('abandoned');
  rpc.mockImplementation(async method => method === 'thread/start' ? { thread: { id: 'new-after-cancel' } } : { thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed' }] } });
  expect(await service.recoverSession('w', { requestId: 'explicit-new-attempt' })).toMatchObject({ threadId: 'new-after-cancel', sessionRecovery: { status: 'completed' } });
  expect(store.records('w', 'session-recovery').map(record => record.status)).toEqual(['abandoned', 'completed']);
});
it('cancellation cannot detach an active or unknown original run', async () => {
  const work = store.get('w')!; work.state = 'recovery-required'; work.executionUnconfirmed = true;
  work.sessionRecovery = { requestId: 'unsafe-cancel', status: 'uncertain', previousThreadId: 'old' }; store.save(work);
  store.record('recovery', 'w', 'session-recovery', work.sessionRecovery);
  const close = vi.spyOn(service.client, 'close');
  await expect((service as any).cancelSessionRecovery('w', { requestId: 'unsafe-cancel' })).rejects.toThrow();
  expect(close).not.toHaveBeenCalled();
});
it('failed cancellation verification preserves uncertainty and context without creating another thread', async () => {
  const work = store.get('w')!; work.executionUnconfirmed = false;
  work.sessionRecovery = { requestId: 'cannot-confirm', status: 'uncertain', previousThreadId: 'old' }; store.save(work);
  store.record('recovery', 'w', 'session-recovery', work.sessionRecovery);
  store.record('context', 'w', 'session-recovery-context', { source: 'board', text: 'preserved context' });
  vi.spyOn(CodexClient.prototype, 'ready').mockResolvedValue();
  const rpc = vi.spyOn(CodexClient.prototype, 'rpc').mockRejectedValue(new Error('read not available'));
  await expect((service as any).cancelSessionRecovery('w', { requestId: 'cannot-confirm' })).rejects.toThrow('종료를 확인하지 못했습니다');
  expect(store.get('w')?.sessionRecovery).toMatchObject({ status: 'uncertain' });
  expect(store.records('w', 'session-recovery-context')[0].text).toBe('preserved context');
  expect(rpc.mock.calls.map(call => call[0])).toEqual(['thread/read']);
  expect(new DesktopLifecycle(store).status().idle).toBe(true);
});
it('a child observed completed by a later wait allows its parent and reconnect to finish normally', async () => {
  const items = [
    { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running' } } },
    { id: 'wait', type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: ['child'], agentsStates: { child: { status: 'completed' } } },
  ];
  const work = store.get('w')!; work.state = 'recovery-required'; work.executionUnconfirmed = true; store.save(work);
  vi.spyOn(service.client, 'rpc').mockResolvedValue({ thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed', items }] } });
  await service.reconnect('w');
  expect(desktopHealth(store).runtime(store.get('w')!)).toBe('inactive');
  (service as any).active.set('w', { token: Symbol(), generation: service.client.generation, turnId: 'next', state: 'active' });
  for (const item of items) service.client.emit('notification', { method: 'item/completed', params: { threadId: 'old', turnId: 'next', item } });
  service.client.emit('notification', { method: 'turn/completed', params: { threadId: 'old', turn: { id: 'next', status: 'completed' } } });
  expect(desktopHealth(store).runtime(store.get('w')!)).toBe('inactive');
});
it.each(['started', 'interacted'])('new-schema subagent %s prevents replacement until its latest activity terminates', async kind => {
  const items = [{ id: 'activity', type: 'subAgentActivity', kind, agentThreadId: 'native-child' }];
  const rpc = vi.spyOn(service.client, 'rpc').mockImplementation(async method => method === 'thread/read' ? { thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed', items }] } } : { thread: { id: 'new' } });
  expect((await service.recoverSession('w', { requestId: 'native-child' })).sessionRecovery).toMatchObject({ status: 'blocked' });
  items.push({ id: 'done', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'native-child' });
  expect((await service.recoverSession('w', { requestId: 'native-child' })).sessionRecovery).toMatchObject({ status: 'completed' });
  expect(rpc.mock.calls.filter(call => call[0] === 'thread/start')).toHaveLength(1);
});
it.each(['resumeAgent', 'sendInput', 'followupTask'])('a %s after a terminal child resets ownership to unknown without newer terminal evidence', async tool => {
  const items = [
    { id: 'wait', type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: ['child'], agentsStates: { child: { status: 'completed' } } },
    { id: 'new-work', type: 'collabAgentToolCall', tool, receiverThreadIds: ['child'], agentsStates: {} },
  ];
  vi.spyOn(service.client, 'rpc').mockResolvedValue({ thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed', items }] } });
  expect((await service.recoverSession('w', { requestId: 'new-child-work' })).sessionRecovery).toMatchObject({ status: 'blocked' });
});
it('keeps the recovered execution folder for subsequent planning messages', async () => {
  const path = join(root, 'isolated'); mkdirSync(join(path, 'openspec/changes/test'), { recursive: true });
  const work = store.get('w')!; work.executionPath = path; store.save(work);
  vi.spyOn(WorkRecovery.prototype, 'path').mockReturnValue(path); vi.spyOn(FileResults.prototype, 'path').mockReturnValue(path);
  const rpc = vi.spyOn(service.client, 'rpc').mockImplementation(async method => method === 'thread/read' ? { thread: { id: 'old', turns: [{ id: 'known-turn', status: 'completed' }] } } : method === 'thread/start' ? { thread: { id: 'new' } } : { turn: { id: 'next' } });
  await service.recoverSession('w', { requestId: 'folder' });
  await service.send('w', 'review current recovered files');
  expect(rpc.mock.calls.find(call => call[0] === 'turn/start')?.[1]).toMatchObject({ cwd: path });
});

it('separate recovered planning folders do not block each other through their common project', () => {
  const left = join(root, 'left'), right = join(root, 'right'); mkdirSync(left); mkdirSync(right);
  const work = store.get('w')!;
  store.save({ ...work, id: 'other', requestKey: 'other', changeName: 'other', executionPath: right, threadId: 'other-thread', state: 'running', executionUnconfirmed: true, sessionRecovery: { status: 'completed', newThreadId: 'other-thread' } });
  expect(() => new WorkRecovery(store).assertWritableFolder(work, left)).not.toThrow();
  expect(() => new WorkRecovery(store).assertWritableFolder(work, right)).toThrow();
});

it('a later blocked recovery cannot change the existing recovered thread folder', () => {
  const isolated = join(root, 'isolated'), separate = join(root, 'separate'); mkdirSync(isolated); mkdirSync(separate);
  const work = store.get('w')!; work.executionPath = isolated; work.sessionRecovery = { requestId: 'later', status: 'blocked', previousThreadId: 'old' }; store.save(work);
  store.record('original-recovery', 'w', 'session-recovery', { requestId: 'original', status: 'completed', newThreadId: 'old' });
  vi.spyOn(WorkRecovery.prototype, 'path').mockReturnValue(isolated);
  expect((service as any).executionCwd(store.get('w'))).toBe(isolated);
  const target = { ...work, id: 'other', requestKey: 'other', changeName: 'other' }; store.save(target);
  work.state = 'running'; work.executionUnconfirmed = true; store.save(work);
  expect(() => new WorkRecovery(store).assertWritableFolder(target, separate)).not.toThrow();
  expect(() => new WorkRecovery(store).assertWritableFolder(target, isolated)).toThrow();
});
it('disposes an observed terminal idle connection after the grace period and reconnects lazily', async () => {
  vi.useFakeTimers();
  const first = (service as any).clientFor('w'), close = vi.spyOn(first, 'close');
  first.emit('notification', { method: 'turn/completed', params: { threadId: 'old', turn: { id: 'known-turn', status: 'completed' } } });
  await vi.advanceTimersByTimeAsync(120001);
  expect(close).toHaveBeenCalledTimes(1);
  expect((service as any).clients.has('w')).toBe(false);
  expect((service as any).clientFor('w')).not.toBe(first);
});
it.each(['active', 'unknown'])('never disposes a connection that becomes %s during its idle grace period', async state => {
  vi.useFakeTimers();
  const first = (service as any).clientFor('w'), close = vi.spyOn(first, 'close');
  first.emit('notification', { method: 'turn/completed', params: { threadId: 'old', turn: { id: 'known-turn', status: 'completed' } } });
  (service as any).active.set('w', { token: Symbol(), generation: first.generation, turnId: 'new', state });
  await vi.advanceTimersByTimeAsync(120001);
  expect(close).not.toHaveBeenCalled(); expect((service as any).clientFor('w')).toBe(first);
});
