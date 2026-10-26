import { intlLocale, type Locale } from './locale';
import { enTestCopy, koTestCopy } from './testMessages';
import { enCopy, koCopy } from './catalog';
import { enProjectCopy, koProjectCopy } from './projectMessages';
import { enSourceCopy, koSourceCopy } from './sourceMessages';
import { enEdgeCopy, koEdgeCopy } from './edgeMessages';
import { enRecoveryCopy, koRecoveryCopy } from './recoveryMessages';
import { enBrowserCopy, koBrowserCopy } from './browserMessages';

const en = {
  ...enBrowserCopy,
  ...enTestCopy,
  ...enRecoveryCopy,
  ...enCopy,
  ...enProjectCopy,
  ...enSourceCopy,
  ...enEdgeCopy,
  'project.selectWork': 'Choose a work for AI and verification', 'project.newWork': 'Create an idea / work', 'project.returnWork': 'Return to work', 'project.noWork': 'No active work for this project.',
  'fileDiff.binary': 'Binary file: text comparison is unavailable.',
  'fileDiff.sizeLimit': 'File content exceeds the 200,000-byte limit.',
  'changeResults.work': 'Work', 'changeResults.current': 'Current changes', 'changeResults.completed': 'Changes at completion',
  'changeResults.started': 'Baseline', 'changeResults.ended': 'Completed', 'changeResults.noTime': 'Not recorded',
  'changeResults.isolated': 'Only changes in this work’s independent workspace are included.',
  'changeResults.empty': 'No changed files.', 'changeResults.unavailable': 'No isolated change record is available for this work.',
  'changeResults.applied': 'Applied to the original project', 'changeResults.notApplied': 'Not applied to the original project',
  'changeResults.conflict': 'Original project conflict. Resolve the conflicting paths before retrying.',
  'changeResults.recovery': 'Application was interrupted. Retry to recover using the saved journal.',
  'changeResults.apply': 'Apply to original project', 'changeResults.policy': 'Collection rules',
  'changeResults.transition': 'Create an isolated workspace', 'changeResults.transitionHint': 'Changes will be collected from the transition time onward. Earlier changes cannot be attributed retroactively.',
  'changeResults.policyHint': 'Symlinks, *.tsbuildinfo and the excluded folders are omitted. Text must be under 200,000 bytes with no NUL bytes. Changes only to tasks.md checkboxes are ignored.',
  'fileDiff.title': 'Changed lines',
  'fileDiff.oldLine': 'Old line',
  'fileDiff.newLine': 'New line',
  'fileDiff.type': 'Change type',
  'fileDiff.content': 'Changes',
  'fileDiff.full': 'Show full before / after code',
  'fileDiff.noNewline': 'No newline at end of file',
  'fileDiff.unavailable': 'Text comparison is unavailable for this file.',
  'fileDiff.limit': 'This comparison is too large. View the full code below.',
  'fileDiff.unchanged': 'No changed text lines.',
  'fileDiff.counts': ({ added, removed }: { added: number; removed: number }) => `${added} lines added · ${removed} lines deleted`,
  'fileDiff.expand': ({ count }: { count: number }) => `Show ${count} unchanged lines`,
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
  ...koBrowserCopy,
  ...koTestCopy,
  ...koRecoveryCopy,
  ...koProjectCopy,
  ...koSourceCopy,
  ...koEdgeCopy,
  'project.selectWork': 'AI·검증에 사용할 업무 선택', 'project.newWork': '아이디어·업무 만들기', 'project.returnWork': '업무로 돌아가기', 'project.noWork': '이 프로젝트에 진행 중인 업무가 없습니다.',
  ...koCopy,
  'fileDiff.binary': '바이너리 파일: 텍스트 내용을 비교할 수 없습니다.',
  'fileDiff.sizeLimit': '파일 내용이 200,000바이트 제한 이상입니다.',
  'changeResults.work': '업무', 'changeResults.current': '현재 변경', 'changeResults.completed': '완료 당시 변경',
  'changeResults.started': '시작 기준', 'changeResults.ended': '완료 시점', 'changeResults.noTime': '기록 없음',
  'changeResults.isolated': '이 업무의 독립 실행 공간에서 발생한 변경만 표시합니다.',
  'changeResults.empty': '변경된 파일이 없습니다.', 'changeResults.unavailable': '이 업무의 업무별 변경 기록이 없습니다.',
  'changeResults.applied': '원본 프로젝트에 반영됨', 'changeResults.notApplied': '원본 프로젝트에 아직 반영하지 않음',
  'changeResults.conflict': '원본 반영 충돌이 있습니다. 충돌 경로를 해결한 뒤 다시 요청해 주세요.',
  'changeResults.recovery': '원본 반영이 중단되었습니다. 다시 요청하면 저장된 기록으로 복구합니다.',
  'changeResults.apply': '원본에 반영', 'changeResults.policy': '변경 수집 규칙',
  'changeResults.transition': '업무 전용 공간으로 전환', 'changeResults.transitionHint': '전환 시점부터 변경을 수집합니다. 이전 변경의 업무별 기록은 복원하지 않습니다.',
  'changeResults.policyHint': '심볼릭 링크, *.tsbuildinfo와 제외 폴더는 수집하지 않습니다. 텍스트는 200,000바이트 미만이며 NUL이 없어야 합니다. tasks.md 체크박스만 바뀐 경우는 변경 목록에서 제외합니다.',
  'fileDiff.title': '수정된 줄',
  'fileDiff.oldLine': '변경 전 줄',
  'fileDiff.newLine': '변경 후 줄',
  'fileDiff.type': '변경 종류',
  'fileDiff.content': '변경 내용',
  'fileDiff.full': '전체 변경 전·후 코드 보기',
  'fileDiff.noNewline': '줄 끝 개행 없음',
  'fileDiff.unavailable': '텍스트 내용을 비교할 수 없는 파일입니다.',
  'fileDiff.limit': '비교 범위가 너무 큽니다. 아래에서 전체 코드를 확인해 주세요.',
  'fileDiff.unchanged': '표시할 텍스트 줄 변경이 없습니다.',
  'fileDiff.counts': ({ added, removed }) => `${added}줄 추가 · ${removed}줄 삭제`,
  'fileDiff.expand': ({ count }) => `변경 없는 ${count}줄 펼치기`,
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
