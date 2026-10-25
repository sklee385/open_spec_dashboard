import type { ReviewItem, ReviewResponse } from '../hooks/useReviewItems';
import { useI18n } from '../i18n/context';
import './ReviewItems.css';

export function ReviewItems({ data, loading, error, busy = false, refresh, onSelect }: { data: ReviewResponse | null; loading: boolean; error: boolean; busy?: boolean; refresh: () => Promise<ReviewResponse | null>; onSelect: (item: ReviewItem) => void }) {
  const { t } = useI18n();
  const kinds = { confirm: t('review.confirm'), assumption: t('review.assumption'), decision: t('review.decision'), choice: t('review.choice') };
  const failed = error || !!data?.errors.length;
  const groups = new Map<string, ReviewItem[]>();
  for (const item of data?.items || []) groups.set(item.path, [...(groups.get(item.path) || []), item]);
  return <div className="review-items" aria-label={t('review.title')}>
    <p className="review-hint">{t('review.hint')}</p>
    {!data && !error && <p role="status">{t('review.loading')}</p>}
    {failed && <div role="alert"><p>{error ? t('review.error') : t('review.partial')}</p>
      {data?.errors.map(failure => <p key={failure.path}>{failure.path} · {failure.code}</p>)}
      <button disabled={busy || (loading && !data)} onClick={() => void refresh()}>{t('review.retry')}</button></div>}
    {!failed && data?.items.length === 0 && <p>{t('review.empty')}</p>}
    <p className="review-hint">{t('review.syntax')}</p>
    {[...groups].map(([path, items]) => <section key={path}><h3>{path}</h3><ul>{items.map(item => <li key={item.id}>
      <button disabled={busy || (loading && !data) || error} onClick={() => onSelect(item)}><span className="review-kind">{kinds[item.kind]}</span><span className="review-text">{item.text}</span><small>{item.startLine}–{item.endLine} · {t('review.source')}</small></button>
    </li>)}</ul></section>)}
  </div>;
}
