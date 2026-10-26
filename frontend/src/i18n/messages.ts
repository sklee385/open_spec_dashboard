import { intlLocale, type Locale } from './locale';
import { enTestCopy, koTestCopy } from './testMessages';
import { enCopy, koCopy } from './catalog';

const en = {
  ...enTestCopy,
  ...enCopy,

  'common.close': 'Close',
  'common.itemCount': ({ count }: { count: number }) => `${new Intl.NumberFormat('en-US').format(count)} ${count === 1 ? 'item' : 'items'}`,
  'common.named': ({ name }: { name: string }) => name,
  'common.progress': ({ done, total }: { done: number; total: number }) => `${formatNumber('en', done)} of ${formatNumber('en', total)} ${total === 1 ? 'task' : 'tasks'}`,
  'common.waiting': ({ names }: { names: string }) => `Waiting for ${names}`,
  'kanban.emptyColumn': ({ name }: { name: string }) => `No items in ${name}`,
  'specs.choose': ({ mobile }: { mobile: boolean }) => `Choose from the ${mobile ? 'menu' : 'sidebar'} to get started`,
  'workRoom.runCommand': ({ name }: { name: string }) => `Run ${name}`,
  'workRoom.argsHint': 'Enter one argument per line\nrun\ntest',
  'workRoom.passed': 'Passed',
  'workRoom.added': 'Added',
  'workRoom.modified': 'Modified',
  'workRoom.removed': 'Removed',
  'workRoom.queuedStatus': 'Queued',
  'settings.pathExample': '/path/to/repo/openspec',
};
type MessageArgs<K extends keyof typeof en> = (typeof en)[K] extends (args: infer A) => string ? A : Record<string, never>;
export type MessageKey = keyof typeof en;
type Dictionary = { [K in MessageKey]: (typeof en)[K] extends string ? string : (typeof en)[K] };
const ko: Dictionary = {
  ...koTestCopy,
  ...koCopy,

  'common.close': '닫기',
  'common.itemCount': ({ count }) => `${new Intl.NumberFormat('ko-KR').format(count)}개`,
  'common.named': ({ name }) => name,
  'common.progress': ({ done, total }) => `${formatNumber('ko', total)}개 작업 중 ${formatNumber('ko', done)}개 완료`,
  'common.waiting': ({ names }) => `${names} 대기 중`,
  'kanban.emptyColumn': ({ name }) => `${name}에 항목이 없습니다`,
  'specs.choose': ({ mobile }) => `${mobile ? '메뉴' : '사이드바'}에서 명세를 선택하세요`,
  'workRoom.runCommand': ({ name }) => `${name} 실행`,
  'workRoom.argsHint': '인자를 한 줄씩 입력\nrun\ntest',
  'workRoom.passed': '통과',
  'workRoom.added': '추가됨',
  'workRoom.modified': '수정됨',
  'workRoom.removed': '삭제됨',
  'workRoom.queuedStatus': '대기 중',
  'settings.pathExample': '/저장소/경로/openspec',
};
export const dictionaries = { en, ko };

export function translate<K extends MessageKey>(locale: Locale, key: K, args: MessageArgs<K>, source: { en: Dictionary; ko: Partial<Dictionary> } = dictionaries): string {
  const message = source[locale][key] ?? source.en[key];
  return typeof message === 'function' ? (message as (value: MessageArgs<K>) => string)(args) : message;
}

export function createTranslator(locale: Locale) {
  return <K extends MessageKey>(key: K, ...args: (typeof en)[K] extends string ? [] : [MessageArgs<K>]) => translate(locale, key, (args[0] ?? {}) as MessageArgs<K>);
}
export type Translator = ReturnType<typeof createTranslator>;
export const formatNumber = (locale: Locale, value: number) => new Intl.NumberFormat(intlLocale(locale)).format(value);
