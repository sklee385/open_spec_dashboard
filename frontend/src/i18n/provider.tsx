import { useMemo, type ReactNode } from 'react';
import { I18nContext } from './context';
import { createTranslator } from './messages';
import type { Locale } from './locale';

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => ({ locale, t: createTranslator(locale) }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
