import { expect, it, vi } from 'vitest';
import { RequestBasisProof } from '../src/work/request-basis-proof';

it('한 요청의 완전 검증은 한 번만 실행하고 매 checkpoint는 새 근거를 읽는다', async () => {
  let stamp = 'original'; const full = vi.fn(async () => ({ context: 'verified' })), read = vi.fn(async () => stamp);
  const proof = await RequestBasisProof.create(full, read);
  expect(await proof.check(read)).toEqual({ context: 'verified' });
  expect(await proof.check(read)).toEqual({ context: 'verified' });
  expect(full).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(4);
  stamp = 'changed'; await expect(proof.check(read)).rejects.toThrow(); expect(full).toHaveBeenCalledTimes(1);
});
it.each(['document', 'commands', 'source', 'index', 'ref', 'progress', 'verification', 'question', 'owner', 'request'])('%s 변경은 await 뒤 원래 proof를 재사용하지 못한다', async dimension => {
  const state: Record<string, number> = { [dimension]: 0 }, read = async () => JSON.stringify(state);
  const proof = await RequestBasisProof.create(async () => ({ context: 'verified' }), read);
  await expect(proof.check(read, async () => { state[dimension]++; })).rejects.toThrow();
});
it('최초 완전 검증 await 도중 변경도 proof를 발급하지 않는다', async () => {
  let stamp = 'original'; await expect(RequestBasisProof.create(async () => { stamp = 'changed'; return {}; }, async () => stamp)).rejects.toThrow();
});
it('browser snapshot 검증은 checkpoint마다 독립 실행하고 실패를 전달한다', async () => {
  const read = async () => 'unchanged', proof = await RequestBasisProof.create(async () => ({}), read), browser = vi.fn(async () => {});
  await proof.check(read, browser); await proof.check(read, browser); expect(browser).toHaveBeenCalledTimes(2);
  await expect(proof.check(read, async () => { throw new Error('stale browser'); })).rejects.toThrow('stale browser');
});
