export type Locale = 'ko' | 'en';
export const intlLocale = (locale: Locale) => locale === 'ko' ? 'ko-KR' : 'en-US';

export function selectLocale(languages?: readonly string[], language?: string): Locale {
  for (const tag of languages?.length ? languages : [language]) {
    const base = tag?.toLowerCase().split('-')[0];
    if (base === 'ko' || base === 'en') return base;
  }
  return 'en';
}

export function detectLocale(read = () => navigator): Locale {
  try {
    const browser = read();
    const languages = browser.languages;
    return selectLocale(languages, languages?.length ? undefined : browser.language);
  } catch { return 'en'; }
}

export function initializeLocale(locale: Locale = 'ko'): Locale {
  document.documentElement.lang = locale;
  return locale;
}
