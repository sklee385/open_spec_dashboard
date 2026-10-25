import { createContext, useContext } from 'react';
import { createTranslator } from './messages';
import type { Locale } from './locale';

export const I18nContext = createContext({ locale: 'en' as Locale, t: createTranslator('en') });
export const useI18n = () => useContext(I18nContext);
