import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claimAttention } from './attentionStore';
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());
it('동시 연결에서 한 요청의 발행 권한을 한 번만 획득하고 다시 열어도 유지한다', async () => {
  const claims = await Promise.all(Array.from({ length: 8 }, () => claimAttention('work', 'question')));
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await claimAttention('work', 'question')).toBe(false);
  expect(await claimAttention('work', 'other')).toBe(true);
  expect(await claimAttention('other', 'question')).toBe(true);
});
it('구분자가 포함된 식별자도 충돌 없이 격리한다', async () => {
  expect(await claimAttention('a:b', 'c')).toBe(true);
  expect(await claimAttention('a', 'b:c')).toBe(true);
});
it('저장소 미지원·열기 실패·쓰기 실패를 발행 권한으로 취급하지 않는다', async () => {
  vi.stubGlobal('indexedDB', undefined);
  await expect(claimAttention('w', 'q')).rejects.toThrow();
  vi.stubGlobal('indexedDB', { open() { throw new Error('denied'); } });
  await expect(claimAttention('w', 'q')).rejects.toThrow('denied');
  const factory = new IDBFactory(); vi.stubGlobal('indexedDB', factory);
  const original = factory.open.bind(factory);
  vi.spyOn(factory, 'open').mockImplementation((...args) => {
    const request = original(...args);
    request.addEventListener('success', () => vi.spyOn(request.result, 'transaction').mockImplementation(() => { throw new Error('quota'); }));
    return request;
  });
  await expect(claimAttention('w', 'q')).rejects.toThrow('unavailable');
});
