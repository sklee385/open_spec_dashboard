import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { inspectWorkspacePath } from './workspace-paths';
import { readGitBufferSync } from '../projects/git-runner';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type CleanFilePolicy = { format: string; autocrlf: string; filemode: string; attributes: Map<string, Record<string, string>>; index: Map<string, { mode: string; blob: string }>; cachedSizes: Map<string, number> };

/** Shared bounded raw Git comparison. No status/diff or external clean helper executes. */
export function readCleanTrackedFiles(root: string, tracked: string[], policy?: CleanFilePolicy) {
  if (tracked.length > 10000) throw new ConflictException('원본 추적 파일 검사 한도를 초과했습니다');
  let total = 0;
  return tracked.map(path => {
    const absolute = resolve(root, path), rel = relative(root, absolute);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new ConflictException('원본 추적 파일 경계를 확인해 주세요');
    inspectWorkspacePath(dirname(absolute), []);
    const before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 128 * 1024 * 1024 || (total += before.size) > 512 * 1024 * 1024) throw new ConflictException('원본 추적 파일 소유 또는 검사 한도를 확인해 주세요');
    const digest = createHash('sha256'), descriptor = openSync(absolute, 'r'), buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      const opened = fstatSync(descriptor);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || !opened.isFile()) throw new ConflictException('원본 추적 파일 소유가 변경되었습니다');
      const expected = policy?.index.get(path), attributes = policy?.attributes.get(path) ?? {};
      const normalize = !!policy && attributes.text !== 'unset' && (['set', 'auto'].includes(attributes.text) || ['lf', 'crlf'].includes(attributes.eol) || ['true', 'input'].includes(policy.autocrlf));
      const blob = policy ? createHash(policy.format).update(`blob ${before.size}\0`) : undefined;
      let bytes = 0, count: number, crlf = 0, carriageReturns = 0, previousCR = false, binary = false;
      while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
        bytes += count; if (bytes > before.size) throw new ConflictException('원본 추적 파일이 검사 중 변경되었습니다');
        const chunk = buffer.subarray(0, count); digest.update(chunk); blob?.update(chunk);
        if (normalize) {
          const text = chunk.toString('latin1');
          // Supported subset: no bare CR, NUL, DEL or non-printing controls.
          // Do not approximate Git's binary heuristic by normalizing those bytes.
          binary ||= /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
          if (previousCR && chunk[0] === 10) crlf++;
          crlf += text.match(/\r\n/g)?.length ?? 0; carriageReturns += text.match(/\r/g)?.length ?? 0; previousCR = chunk.at(-1) === 13;
        }
      }
      if (bytes !== before.size) throw new ConflictException('원본 추적 파일 크기가 변경되었습니다');
      if (policy) {
        const cachedSize = policy.cachedSizes.get(path);
        if (cachedSize === undefined || cachedSize !== 0 && cachedSize !== before.size) throw new ConflictException('원본 파일 크기가 Git index stat과 다릅니다');
        if (!expected || !['100644', '100755'].includes(expected.mode) || policy.filemode !== 'false' && expected.mode !== (before.mode & 0o111 ? '100755' : '100644')) throw new ConflictException('원본 추적 파일 mode가 index와 다릅니다');
        if (blob!.digest('hex') !== expected.blob) {
          if (!normalize || binary || carriageReturns !== crlf) throw new ConflictException('원본 추적 파일 바이트가 index와 다르거나 안전한 텍스트 정규화를 확인할 수 없습니다');
          // Same supported text/eol/autocrlf rule as candidate editing, without running Git clean filters.
          const normalized = createHash(policy.format).update(`blob ${before.size - crlf}\0`);
          let position = 0, carry = false;
          while ((count = readSync(descriptor, buffer, 0, buffer.length, position)) > 0) {
            position += count; if (position > before.size) throw new ConflictException('원본 추적 파일이 검사 중 변경되었습니다');
            const chunk: Buffer = carry ? Buffer.concat([Buffer.from([13]), buffer.subarray(0, count)]) : buffer.subarray(0, count);
            carry = chunk.at(-1) === 13;
            normalized.update(Buffer.from(chunk.subarray(0, chunk.length - Number(carry)).toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));
          }
          if (carry) normalized.update(Buffer.from([13]));
          if (position !== before.size || normalized.digest('hex') !== expected.blob) throw new ConflictException('원본 추적 파일 바이트가 index와 다릅니다');
        }
      }
    } finally { closeSync(descriptor); }
    const after = lstatSync(absolute);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1 || !after.isFile() || after.size !== before.size) throw new ConflictException('원본 추적 파일이 검사 중 변경되었습니다');
    return [path, before.dev, before.ino, before.mode, before.mtimeMs, before.ctimeMs, digest.digest('hex')];
  });
}
export function readGitTextAttributes(root: string, tracked: string[], source?: string) {
  const input = Buffer.from(tracked.length ? `${tracked.join('\0')}\0` : '');
  if (input.length > 1024 * 1024) throw new ConflictException('원본 속성 검사 한도를 초과했습니다');
  const values = readGitBufferSync(root, ['-c', 'core.fsmonitor=false', 'check-attr', ...(source ? [`--source=${source}`] : []), '-z', '--stdin', 'filter', 'working-tree-encoding', 'ident', 'text', 'eol'], input).toString();
  const fields = values.split('\0'), attributes = new Map<string, Record<string, string>>();
  for (let n = 0; n + 2 < fields.length; n += 3) {
    if (['filter', 'working-tree-encoding', 'ident'].includes(fields[n + 1]) && !['unspecified', 'unset'].includes(fields[n + 2])) throw new ConflictException('원본 실제 속성의 필터·인코딩·ident 변환을 지원하지 않습니다');
    const row = attributes.get(fields[n]) ?? {}; row[fields[n + 1]] = fields[n + 2]; attributes.set(fields[n], row);
  }
  return { version: hash(values), attributes };
}
export function parseGitCachedSizes(debug: string) {
  const sizes = new Map<string, number>(); let cursor = 0;
  while (cursor < debug.length) {
    const end = debug.indexOf('\0', cursor);
    if (end < 0) throw new ConflictException('원본 index stat 형식을 확인할 수 없습니다');
    const path = debug.slice(cursor, end), fields = /^(?:  [^\n]*\n){4}  size: ([0-9]+)\tflags: [0-9a-fA-F]+\r?\n/.exec(debug.slice(end + 1));
    if (!fields || sizes.has(path) || !Number.isSafeInteger(Number(fields[1]))) throw new ConflictException('원본 index stat 형식을 확인할 수 없습니다');
    sizes.set(path, Number(fields[1])); cursor = end + 1 + fields[0].length;
  }
  return sizes;
}
