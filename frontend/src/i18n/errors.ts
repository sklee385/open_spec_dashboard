import type { MessageKey, Translator } from './messages';

type ErrorKey = Extract<MessageKey, 'workRoom.noResponse' | 'workRoom.requestError' | 'settings.loadError' | 'settings.updateError' | 'review.changed'>;
export class ProductError extends Error {
  readonly key: ErrorKey;
  constructor(key: ErrorKey) { super(key); this.key = key; }
}
export function errorMessage(error: unknown, t: Translator): string {
  return error instanceof ProductError ? t(error.key) : error instanceof Error ? error.message : t('workRoom.requestError');
}
