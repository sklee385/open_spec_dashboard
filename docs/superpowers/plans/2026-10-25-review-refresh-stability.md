# 사용자 검토 갱신 안정화 실행 계획

1. `frontend/src/components/ReviewItems.test.tsx`의 기존 배경 갱신 테스트에 `expect(screen.queryByRole('status')).not.toBeInTheDocument()`를 추가한다.
2. 빈 목록의 SSE 갱신 응답을 보류하는 테스트를 추가하고 갱신 시작·완료 모두 기존 빈 목록 안내를 유지하는지 확인한다.
3. `./scripts/npm.ps1 run test:run --workspace frontend -- src/components/ReviewItems.test.tsx`로 두 회귀 테스트의 실패를 확인한다.
4. `ReviewItems.tsx`에서 로딩 조건을 `!data && !error`, 빈 목록 조건을 `!failed && data?.items.length === 0`으로 변경하고 중복 로딩 분기를 제거한다.
5. 사용자 검토·원문 이동 테스트와 프런트엔드 빌드를 실행한다. 첫 조회·오류·선택 동작에 회귀가 없는지 확인한다.
6. 실행 중인 AI 세션을 종료하지 않고 데스크톱 프런트엔드 정적 파일만 갱신해 네이티브 앱에서 검토 화면을 확인한다.

승인한 설계를 현재 세션에서 직접 실행했다. 후속 사용자 요청에 따라 이번 수정과 관련 테스트·문서만 커밋한다.
