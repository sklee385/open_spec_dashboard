import { expect, it } from 'vitest';
import { formatRelativeTime, formatDateTime } from './utils';

const now = Date.parse('2026-10-25T12:00:00Z');
it.each([59, 60, 3599, 3600, 86399, 86400, 604799, 604800])('상대 시간 경계를 언어별로 표시한다: %i초', seconds => {
  const input = new Date(now - seconds * 1000).toISOString();
  const ko = formatRelativeTime(input, 'ko', now), en = formatRelativeTime(input, 'en', now);
  expect(ko).not.toBe(en);
  if (seconds < 60) { expect(ko).toBe('방금 전'); expect(en).toBe('just now'); }
  else if (seconds < 3600) expect(ko).toContain('분');
  else if (seconds < 86400) expect(ko).toContain('시간');
  else if (seconds < 604800) expect(ko).toContain('일');
});
it('날짜 언어만 바꾸고 입력 시각은 보존한다', () => {
  const input = '2026-10-25T12:00:00Z';
  expect(formatDateTime(input, 'ko')).toBe(new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(input)));
  expect(formatDateTime(input, 'en')).toBe(new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(input)));
  expect(input).toBe('2026-10-25T12:00:00Z');
});
