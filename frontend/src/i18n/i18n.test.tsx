import { afterEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { detectLocale, selectLocale, initializeLocale } from './locale';
import { I18nProvider } from './provider';
import { useI18n } from './context';
import { dictionaries, translate } from './messages';

afterEach(() => vi.unstubAllGlobals());
it.each([
  [['ko-KR', 'en-US'], 'en', 'ko'],
  [['EN-gb', 'ko'], 'ko', 'en'],
  [['ja', 'ko-KR', 'en'], 'en', 'ko'],
  [[], 'ko-KR', 'ko'],
  [undefined, 'ko', 'ko'],
  [['ja', 'fr'], 'ko', 'en'],
  [[], 'fr', 'en'],
] as const)('브라우저 선호 순서를 선택한다: %j', (languages, language, expected) => {
  expect(selectLocale(languages, language)).toBe(expected);
});
it('브라우저 접근 실패는 영어로 표시한다', () => {
  expect(detectLocale(() => { throw new Error('unavailable'); })).toBe('en');
});
it('초기화마다 언어와 문서 lang을 새로 설정한다', () => {
  vi.stubGlobal('navigator', { languages: ['ko-KR'] });
  expect(initializeLocale()).toBe('ko');
  expect(document.documentElement.lang).toBe('ko');
  vi.stubGlobal('navigator', { languages: ['en-US'] });
  expect(initializeLocale()).toBe('en');
  expect(document.documentElement.lang).toBe('en');
});
it('사전 키는 완전하며 누락된 한국어는 영어로 대체한다', () => {
  expect(Object.keys(dictionaries.ko).sort()).toEqual(Object.keys(dictionaries.en).sort());
  expect(translate('ko', 'common.close', {}, { en: dictionaries.en, ko: {} })).toBe('Close');
});
it.each([0, 1, 2])('수량과 원문 변수를 보존한다: %i', count => {
  const result = translate('en', 'common.itemCount', { count });
  expect(result).toBe(`${count} ${count === 1 ? 'item' : 'items'}`);
  expect(translate('ko', 'common.named', { name: '<원문 & project>' })).toBe('<원문 & project>');
});
it('첫 렌더부터 Provider가 선택한 언어를 제공한다', () => {
  function Probe() { const { t } = useI18n(); return <button>{t('common.close')}</button>; }
  render(<I18nProvider locale="ko"><Probe /></I18nProvider>);
  expect(screen.getByRole('button', { name: '닫기' })).toBeInTheDocument();
});
