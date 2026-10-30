export const enLifecycleCopy = {
  'life.invalidStatus': 'The candidate status response is unavailable. Please inspect it again.',
  'life.title': 'Candidate verification and application', 'life.verifyInspect': 'Inspect candidate verification basis and results', 'life.run': 'Run candidate CLI verification', 'life.confirmRun': 'I reviewed the candidate commands and fixed workspace',
  'life.cliPassed': 'CLI passed', 'life.cliMissing': 'CLI verification required', 'life.browserRequired': 'Candidate browser verification required', 'life.ready': 'Candidate ready for preflight', 'life.notReady': 'Candidate verification is incomplete',
  'life.preflight': 'Inspect original application preflight', 'life.preflightPassed': 'Preflight passed', 'life.apply': 'Explicitly apply to original', 'life.confirmApply': 'I reviewed this candidate and application to the original',
  'life.current': 'Current observation', 'life.previous': 'Past observation', 'life.receipts': 'Saved application receipts', 'life.inspect': 'Observe current original state', 'life.reconcile': 'Reconcile saved application request',
  'life.cancel': 'Cancel candidate logically', 'life.cancelConfirm': 'I confirm cancellation while preserving files, results and conversation', 'life.cancelHint': 'Candidate cancellation preserves files, commits, results and the conversation. It does not undo an application or stop an unknown process.',
  'life.stopRun': 'Request this verification run to stop', 'life.reconcileRun': 'Inspect this verification run termination', 'life.runControlConfirm': 'I reviewed this verification run control',
  'life.separate': 'Applying the original and completing or archiving work are separate actions. None is run automatically.', 'life.unsaved': 'Save or discard the work document or candidate source draft explicitly before verification or application.',
  'life.localReceipt': 'Local control receipt', 'life.live': 'Execution ownership', 'life.fresh': 'Current basis', 'life.stale': 'Stale result', 'life.runHistory': 'Candidate verification history', 'life.historyInspect': 'Inspect saved candidate',
  'life.applied': 'Applied', 'life.cancelled': 'Cancelled', 'life.uncertain': 'Uncertain', 'life.notChecked': 'Not checked', 'life.active': 'Running', 'life.unknown': 'Termination unconfirmed', 'life.settled': 'Termination settled', 'life.failed': 'Failed', 'life.passed': 'Passed',
} as const;
export const koLifecycleCopy: Record<keyof typeof enLifecycleCopy, string> = {
  'life.invalidStatus': '후보 상태 응답을 확인하지 못했습니다. 다시 조회해 주세요.',
  'life.title': '후보 검증·원본 반영', 'life.verifyInspect': '후보 검증 기준·결과 확인', 'life.run': '후보 CLI 검증 실행', 'life.confirmRun': '후보 명령과 고정 실행 공간을 확인했습니다',
  'life.cliPassed': 'CLI 통과', 'life.cliMissing': 'CLI 검증 필요', 'life.browserRequired': '후보 브라우저 검증 필요', 'life.ready': '반영 사전 검사 가능', 'life.notReady': '후보 검증 미완료',
  'life.preflight': '원본 반영 사전 검사', 'life.preflightPassed': '사전 검사 통과', 'life.apply': '원본에 명시적으로 반영', 'life.confirmApply': '표시된 후보와 원본 반영을 확인했습니다',
  'life.current': '현재 관측', 'life.previous': '과거 관측', 'life.receipts': '저장된 반영 영수증', 'life.inspect': '현재 원본 상태 관측', 'life.reconcile': '기존 반영 요청 실제 상태 확인',
  'life.cancel': '후보 논리 취소', 'life.cancelConfirm': '파일·결과·대화를 보존하는 후보 취소를 확인했습니다', 'life.cancelHint': '후보 취소는 파일·커밋·검증 결과·대화를 보존합니다. 원본 반영을 되돌리거나 종료 불명 실행을 중단하지 않습니다.',
  'life.stopRun': '이 검증 실행 중단 요청', 'life.reconcileRun': '이 검증 실행 종료 확인', 'life.runControlConfirm': '이 검증 실행의 제어 요청을 확인했습니다',
  'life.separate': '원본 반영과 업무 완료·보관은 각각 별도 동작입니다. 자동 실행하지 않습니다.', 'life.unsaved': '검증·반영 전에 업무 문서 또는 후보 소스 초안을 명시적으로 저장하거나 버려 주세요.',
  'life.localReceipt': '로컬 제어 영수증', 'life.live': '실행 소유 상태', 'life.fresh': '현재 기준', 'life.stale': '오래된 결과', 'life.runHistory': '후보 검증 이력', 'life.historyInspect': '저장된 후보 확인',
  'life.applied': '반영됨', 'life.cancelled': '취소됨', 'life.uncertain': '불명확', 'life.notChecked': '미관측', 'life.active': '실행 중', 'life.unknown': '종료 미확인', 'life.settled': '종료 확인', 'life.failed': '실패', 'life.passed': '통과',
};
