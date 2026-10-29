import { GitError, readGitBufferSync } from './git-runner';

type GitBlob = { blob: string; size: number };
// Leave headroom below the synchronous runner's 4 MiB output cap.
const outputLimit = 3 * 1024 * 1024, inputLimit = 32768;
const invalid = () => new GitError('Git 기준 파일을 확인할 수 없습니다. 실제 상태 복구가 필요합니다.', 409);

/** Only server-observed ls-tree blob IDs/sizes belong here; no revisions or paths. */
export function readGitBlobsSync<T>(root: string, entries: readonly GitBlob[], consume: (bytes: Buffer) => T): Map<string, T> {
  if (entries.length > 10000) throw new GitError('업무 변경 파일 조회 한도를 초과했습니다.', 409);
  const unique = new Map<string, GitBlob>();
  for (const entry of entries) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.blob) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size >= 200000) throw invalid();
    const previous = unique.get(entry.blob);
    if (previous && previous.size !== entry.size) throw invalid();
    unique.set(entry.blob, entry);
  }
  const result = new Map<string, T>();
  let batch: GitBlob[] = [], outputSize = 0, inputSize = 0;
  const flush = () => {
    if (!batch.length) return;
    const input = Buffer.from(batch.map(entry => `${entry.blob}\n`).join(''));
    const output = readGitBufferSync(root, ['cat-file', '--batch'], input);
    if (output.length !== outputSize || output.length > outputLimit) throw invalid();
    let offset = 0;
    for (const entry of batch) {
      const header = Buffer.from(`${entry.blob} blob ${entry.size}\n`);
      if (!output.subarray(offset, offset + header.length).equals(header)) throw invalid();
      offset += header.length;
      const end = offset + entry.size;
      if (end >= output.length || output[end] !== 10) throw invalid();
      offset = end + 1;
    }
    if (offset !== output.length) throw invalid();
    // Convert only a fully validated batch; consumers must not retain the raw slice.
    offset = 0;
    for (const entry of batch) {
      offset += entry.blob.length + 7 + String(entry.size).length;
      result.set(entry.blob, consume(output.subarray(offset, offset + entry.size)));
      offset += entry.size + 1;
    }
    batch = []; outputSize = 0; inputSize = 0;
  };
  for (const entry of unique.values()) {
    const framedSize = entry.blob.length + 7 + String(entry.size).length + entry.size + 1;
    if (outputSize + framedSize > outputLimit || inputSize + entry.blob.length + 1 > inputLimit) flush();
    batch.push(entry); outputSize += framedSize; inputSize += entry.blob.length + 1;
  }
  flush(); return result;
}
