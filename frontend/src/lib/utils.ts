import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { intlLocale, type Locale } from '../i18n/locale';
import { createTranslator } from '../i18n/messages';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDateTime(dateString: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(dateString));
}

export function formatRelativeTime(dateString: string, locale: Locale, now = Date.now()): string {
  const date = new Date(dateString);
  const diffMs = now - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  const relative = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'always' });
  if (diffSecs < 60) return createTranslator(locale)('common.justNow');
  if (diffMins < 60) return relative.format(-diffMins, 'minute');
  if (diffHours < 24) return relative.format(-diffHours, 'hour');
  if (diffDays < 7) return relative.format(-diffDays, 'day');
  
  return new Intl.DateTimeFormat(intlLocale(locale)).format(date);
}
