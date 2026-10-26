import { useMemo, useState } from 'react';
import { diffLines } from 'diff';
import { useI18n } from '@/i18n/context';
import { CodeBlock, fileLanguage } from './WorkContent';
import './FileDiff.css';

export type FileAvailability = 'text' | 'absent' | 'binary' | 'size-limit' | 'unknown';
export type FileDiffProps = { path: string; before: string | null; after: string | null; beforeAvailability?: FileAvailability; afterAvailability?: FileAvailability };
type Props = FileDiffProps;
type Row = { kind: 'added' | 'removed' | 'context'; text: string; oldLine?: number; newLine?: number; noNewline: boolean };

export function FileDiff({ path, before, after, beforeAvailability, afterAvailability }: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [fullOpen, setFullOpen] = useState(false);
  const unavailable = [beforeAvailability, afterAvailability].some(value => value && !['text', 'absent'].includes(value));
  const reason = (availability?: FileAvailability) => availability === 'binary' ? t('fileDiff.binary') : availability === 'size-limit' ? t('fileDiff.sizeLimit') : t('fileDiff.unavailable');
  const diff = useMemo(() => {
    if (unavailable) return null;
    const parts = diffLines(before ?? '', after ?? '', { timeout: 80, maxEditLength: 10000 });
    if (!parts) return null;
    let oldLine = 1, newLine = 1, added = 0, removed = 0;
    const groups = parts.map(part => {
      const lines = part.value.split('\n');
      if (lines.at(-1) === '') lines.pop();
      const kind = part.added ? 'added' : part.removed ? 'removed' : 'context';
      const rows: Row[] = lines.map((text, index) => ({ kind, text: text.replace(/\r$/, ''), oldLine: kind === 'added' ? undefined : oldLine++, newLine: kind === 'removed' ? undefined : newLine++, noNewline: index === lines.length - 1 && !part.value.endsWith('\n') }));
      if (kind === 'added') added += rows.length;
      if (kind === 'removed') removed += rows.length;
      return { kind, rows };
    });
    return { groups, added, removed };
  }, [before, after, unavailable]);
  const row = (value: Row, key: string) => <tr key={key} data-change={value.kind} className={`file-diff-${value.kind}`}>
    <td className="file-diff-number">{value.oldLine ?? ''}</td><td className="file-diff-number">{value.newLine ?? ''}</td>
    <td className="file-diff-sign" aria-label={value.kind === 'added' ? t('workRoom.added') : value.kind === 'removed' ? t('workRoom.removed') : undefined}>{value.kind === 'added' ? '+' : value.kind === 'removed' ? '−' : ' '}</td>
    <td><code>{value.text || ' '}</code>{value.noNewline && <small className="file-diff-eof">{t('fileDiff.noNewline')}</small>}</td>
  </tr>;
  return <section className="file-diff" aria-label={t('fileDiff.title')}>
    {unavailable ? <p>{reason(beforeAvailability && !['text', 'absent'].includes(beforeAvailability) ? beforeAvailability : afterAvailability)}</p> : before === null && after === null ? <p>{t('fileDiff.unavailable')}</p> : !diff ? <p>{t('fileDiff.limit')}</p> : <>
      <p className="file-diff-counts">{t('fileDiff.counts', { added: diff.added, removed: diff.removed })}</p>
      {!diff.added && !diff.removed ? <p>{t('fileDiff.unchanged')}</p> : <div className="file-diff-scroll"><table><thead><tr><th>{t('fileDiff.oldLine')}</th><th>{t('fileDiff.newLine')}</th><th aria-label={t('fileDiff.type')}></th><th>{t('fileDiff.content')}</th></tr></thead><tbody>
        {diff.groups.map((group, index) => {
          const start = index === 0 ? 0 : 3, end = index === diff.groups.length - 1 ? 0 : 3;
          if (group.kind !== 'context' || expanded.has(index) || group.rows.length <= start + end + 1) return group.rows.map((value, n) => row(value, `${index}:${n}`));
          return [
            ...group.rows.slice(0, start).map((value, n) => row(value, `${index}:start:${n}`)),
            <tr key={`${index}:gap`} className="file-diff-gap"><td colSpan={4}><button type="button" onClick={() => setExpanded(old => new Set([...old, index]))}>{t('fileDiff.expand', { count: group.rows.length - start - end })}</button></td></tr>,
            ...group.rows.slice(group.rows.length - end).map((value, n) => row(value, `${index}:end:${n}`)),
          ];
        })}
      </tbody></table></div>}
    </>}
    <details className="file-diff-full" onToggle={event => setFullOpen(event.currentTarget.open)}><summary>{t('fileDiff.full')}</summary>{fullOpen && <><h3>{t('workRoom.before')}</h3>{before === null ? <p>{beforeAvailability && beforeAvailability !== 'absent' ? reason(beforeAvailability) : t('workRoom.noFile')}</p> : <CodeBlock language={fileLanguage(path)} text={before} />}<h3>{t('workRoom.after')}</h3>{after === null ? <p>{afterAvailability && afterAvailability !== 'absent' ? reason(afterAvailability) : t('workRoom.noFile')}</p> : <CodeBlock language={fileLanguage(path)} text={after} />}</>}</details>
  </section>;
}

export function FileChange({ file, status }: { file: Props; status: string }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{status} · {file.path}</summary>{open && <FileDiff {...file} />}</details>;
}
