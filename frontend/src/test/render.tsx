import { render as renderView, type RenderOptions } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nProvider } from '../i18n/provider';
import type { Locale } from '../i18n/locale';

export function render(view: ReactNode, options: RenderOptions & { locale?: Locale } = {}) {
  const { locale = 'ko', ...rest } = options;
  return renderView(view, { wrapper: ({ children }) => <I18nProvider locale={locale}>{children}</I18nProvider>, ...rest });
}
