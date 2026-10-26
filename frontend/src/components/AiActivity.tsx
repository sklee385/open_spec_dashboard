import { LoaderCircle, CirclePause, MessageCircleQuestion, CircleAlert } from 'lucide-react';
import { useI18n } from '@/i18n/context';

export function isAiWorking(state?: string) {
  return ['running', 'connecting', 'creating-thread'].includes(state || '');
}

export function AiActivity({ state, count }: { state?: string; count?: number }) {
  const { t } = useI18n();
  const working = isAiWorking(state);
  const waiting = state === 'waiting-input' || state === 'waiting-approval';
  const problem = !state || state === 'failed' || state === 'recovery-required';
  const Icon = working ? LoaderCircle : waiting ? MessageCircleQuestion : problem ? CircleAlert : CirclePause;
  const text = working ? t('activity.working') : state === 'waiting-input' ? t('activity.input') : state === 'waiting-approval' ? t('activity.approval') : problem ? t('activity.connection') : t('activity.idle');
  return <span role="status" className={`inline-flex max-w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-semibold ${working ? 'border-cyan-500/40 bg-cyan-500/15 text-cyan-700 dark:text-cyan-300' : waiting ? 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'border-border bg-muted/50 text-muted-foreground'}`}>
    <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${working ? 'animate-spin motion-reduce:animate-none' : ''}`} />
    <span>{text}{working && count !== undefined ? ` · ${count}` : ''}</span>
  </span>;
}
