import { afterEach, expect, it, vi } from 'vitest';
import { readGitBlobsSync as consumeGitBlobs } from '../src/projects/git-blobs';
import * as runner from '../src/projects/git-runner';

afterEach(() => vi.restoreAllMocks());
// Protocol tests copy bytes; production maps to text/hash or binary metadata immediately.
function readGitBlobsSync<T = Buffer>(root: string, entries: readonly { blob: string; size: number }[], consume = ((bytes: Buffer) => Buffer.from(bytes)) as (bytes: Buffer) => T) {
  return consumeGitBlobs(root, entries, consume);
}
const oid = (n: number, width = 40) => n.toString(16).padStart(width, '0');
const frame = (blob: string, bytes: Buffer) => Buffer.concat([Buffer.from(`${blob} blob ${bytes.length}\n`), bytes, Buffer.from('\n')]);
it('다음 batch를 읽기 전에 binary를 null 본문과 해시로 소비해 raw Buffer를 결과에 누적하지 않는다', () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ blob: oid(i + 1), size: 199999 }));
  let consumed = 0, previouslyRequested = 0;
  vi.spyOn(runner, 'readGitBufferSync').mockImplementation((_root, _args, input) => {
    expect(consumed).toBe(previouslyRequested);
    const ids = input!.toString().trim().split('\n'); previouslyRequested += ids.length;
    return Buffer.concat(ids.map(id => frame(id, Buffer.alloc(199999))));
  });
  const result = readGitBlobsSync('fixture', entries, (bytes: Buffer) => { consumed++; return { content: bytes.includes(0) ? null : bytes.toString(), hash: 'lightweight' }; });
  expect(consumed).toBe(100); expect([...result.values()]).toEqual(entries.map(() => ({ content: null, hash: 'lightweight' })));
});
it('batch의 마지막 프레임까지 검증이 끝나기 전에는 앞 객체도 소비하지 않는다', () => {
  const consume = vi.fn(() => null);
  vi.spyOn(runner, 'readGitBufferSync').mockReturnValue(Buffer.concat([frame(oid(1), Buffer.from('a')), Buffer.from(`${oid(2)} tree 1\nb\n`)]));
  expect(() => readGitBlobsSync('fixture', [{ blob: oid(1), size: 1 }, { blob: oid(2), size: 1 }], consume)).toThrow(/Git/);
  expect(consume).not.toHaveBeenCalled();
});
it('빈·개행·NUL 바이트와 SHA-256 ID를 크기 프레임대로 읽고 같은 blob은 한 번만 요청한다', () => {
  const values = [Buffer.alloc(0), Buffer.from('a\nb\0c\r\n')], entries = values.map((v, i) => ({ blob: oid(i + 1, 64), size: v.length }));
  const read = vi.spyOn(runner, 'readGitBufferSync').mockReturnValue(Buffer.concat(entries.map((e, i) => frame(e.blob, values[i]))));
  const result = readGitBlobsSync('fixture', [...entries, entries[0]]);
  expect([...result.values()]).toEqual(values); expect(read).toHaveBeenCalledExactlyOnceWith('fixture', ['cat-file', '--batch'], Buffer.from(entries.map(e => `${e.blob}\n`).join('')));
});
it('요청이 없으면 Git을 실행하지 않는다', () => { const read = vi.spyOn(runner, 'readGitBufferSync'); expect(readGitBlobsSync('fixture', []).size).toBe(0); expect(read).not.toHaveBeenCalled(); });
it.each([
  [{ blob: 'HEAD:path', size: 1 }], [{ blob: 'A'.repeat(40), size: 1 }], [{ blob: oid(1), size: -1 }], [{ blob: oid(1), size: 200000 }], [{ blob: oid(1), size: 1.5 }], [{ blob: oid(1), size: NaN }], [{ blob: oid(1), size: 0 }, { blob: oid(1), size: 1 }],
])('잘못된 metadata는 Git 실행 전에 거부한다: %j', (...entries) => {
  const read = vi.spyOn(runner, 'readGitBufferSync'); expect(() => readGitBlobsSync('fixture', entries)).toThrow(/Git/); expect(read).not.toHaveBeenCalled();
});
it('기존 10000개 파일 조회 한도를 넘기는 입력을 거부한다', () => { expect(() => readGitBlobsSync('fixture', Array.from({ length: 10001 }, (_, i) => ({ blob: oid(i + 1), size: 0 })))).toThrow(/한도/); });
it.each([
  Buffer.from(`${oid(1)} missing\n`), Buffer.from(`${oid(2)} blob 1\na\n`), Buffer.from(`${oid(1)} tree 1\na\n`), Buffer.from(`${oid(1)} blob 2\na\n`), Buffer.from(`${oid(1)} blob 01\na\n`), Buffer.from(`${oid(1)} blob 1\ra\n`), Buffer.from(`${oid(1)} blob 1\na`), Buffer.from(`${oid(1)} blob 1\naX`), Buffer.from(`${oid(1)} blob 1\na\nextra`), Buffer.alloc(0), Buffer.alloc(3 * 1024 * 1024 + 1),
])('누락·순서·형식·길이·종료문자·초과 출력을 거부한다', output => {
  vi.spyOn(runner, 'readGitBufferSync').mockReturnValue(output); expect(() => readGitBlobsSync('fixture', [{ blob: oid(1), size: 1 }])).toThrow(/Git/);
});
it('두 번째 객체가 없거나 순서가 바뀌면 부분 결과를 반환하지 않는다', () => {
  const entries = [1, 2].map(i => ({ blob: oid(i), size: 1 }));
  const read = vi.spyOn(runner, 'readGitBufferSync').mockReturnValue(frame(oid(1), Buffer.from('a')));
  expect(() => readGitBlobsSync('fixture', entries)).toThrow(/Git/);
  read.mockReturnValue(Buffer.concat([frame(oid(2), Buffer.from('b')), frame(oid(1), Buffer.from('a'))])); expect(() => readGitBlobsSync('fixture', entries)).toThrow(/Git/);
});
it('출력과 stdin 한도 안에서 큰/빈 객체 목록을 나누어 읽는다', () => {
  const metadata = new Map<string, number>();
  const read = vi.spyOn(runner, 'readGitBufferSync').mockImplementation((_root, args, input) => {
    expect(args).toEqual(['cat-file', '--batch']); expect(input!.length).toBeLessThanOrEqual(32768);
    const output = Buffer.concat(input!.toString().trim().split('\n').map(id => frame(id, Buffer.alloc(metadata.get(id)!))));
    expect(output.length).toBeLessThanOrEqual(3 * 1024 * 1024); return output;
  });
  const large = Array.from({ length: 40 }, (_, i) => ({ blob: oid(i + 1), size: 199999 }));
  for (const e of large) metadata.set(e.blob, e.size);
  expect(readGitBlobsSync('fixture', large).size).toBe(40); expect(read).toHaveBeenCalledTimes(3); read.mockClear();
  const empty = Array.from({ length: 10000 }, (_, i) => ({ blob: oid(i + 100, 64), size: 0 })); for (const e of empty) metadata.set(e.blob, e.size);
  expect(readGitBlobsSync('fixture', empty).size).toBe(10000); expect(read).toHaveBeenCalledTimes(20);
});
it('하위 Git 오류를 정상 빈 본문으로 바꾸지 않는다', () => { vi.spyOn(runner, 'readGitBufferSync').mockImplementation(() => { throw new Error('Git failed'); }); expect(() => readGitBlobsSync('fixture', [{ blob: oid(1), size: 1 }])).toThrow('Git failed'); });
