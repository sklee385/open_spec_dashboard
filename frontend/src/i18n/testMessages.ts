export const enTestCopy = {
  'tests.work': 'Work tests', 'tests.full': 'Full tests',
  'tests.hint': 'Work tests check changed code. Full tests run all registered verification commands. Remaining commands stop on the first failure.',
  'tests.waiting': 'Not tested', 'tests.stale': 'Retest required',
  'tests.noWork': 'No related tests found. Register a work test command below for unsupported runners or changes.',
  'tests.noFull': 'Register full verification commands below.',
  'tests.fix': 'Prepare a fix request', 'tests.fixPrompt': 'Review these test failures and fix them in this work. Run only the necessary related checks during development.',
  'tests.duration': ({ seconds }: { seconds: string }) => `${seconds}s`,
  'tests.scope': 'Test scope', 'tests.command': 'Command', 'tests.definition': 'Command details', 'tests.status': 'Status', 'tests.history': 'Execution history',
};
export const koTestCopy: { [K in keyof typeof enTestCopy]: (typeof enTestCopy)[K] extends string ? string : (typeof enTestCopy)[K] } = {
  'tests.work': '작업 테스트', 'tests.full': '전체 테스트',
  'tests.hint': '작업 테스트는 변경 관련 테스트를, 전체 테스트는 등록된 필수 검증을 모두 실행합니다. 첫 실패 시 남은 명령을 중지합니다.',
  'tests.waiting': '미검증', 'tests.stale': '재검증 필요',
  'tests.noWork': '변경 관련 테스트를 찾지 못했습니다. 미지원 도구나 변경은 아래에서 작업 테스트 명령을 등록해 주세요.',
  'tests.noFull': '아래에서 전체 테스트 명령을 등록해 주세요.',
  'tests.fix': '실패 결과로 수정 요청', 'tests.fixPrompt': '아래 테스트 실패를 확인하고 같은 업무에서 수정해 주세요. 개발 중에는 필요한 관련 검증만 실행해 주세요.',
  'tests.duration': ({ seconds }) => `${seconds}초`,
  'tests.scope': '테스트 범위', 'tests.command': '명령', 'tests.definition': '명령 상세', 'tests.status': '상태', 'tests.history': '실행 기록',
};
