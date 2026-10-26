# 업무 복구 구현 계획

승인한 OpenSpec add-work-recovery의 proposal.md, design.md, specs/work-sessions/spec.md, tasks.md가 구현 계약이다.

1. backend/test/codex-work.test.ts에 GET 업무 진단과 legacy/isolated 복구 및 손상 차단 검사를 추가한다. 실패 확인 후 backend/src/work/recovery.ts에서 상태 진단과 경로 검증을 분리한다.
2. CodexService의 reconnect에서 최신 상태 재검증과 성공·실패 이벤트를 기록한다. WorkController에서 복구 진단을 응답하며 격리 손상 때문에 업무 화면 자체가 열리지 않는 경우를 처리한다. 실제 문서 조회는 계속 차단한다.
3. frontend/src/components/WorkRoomRecovery.test.tsx에 버튼·원인 안내·재시도·초안 보존 테스트를 추가한다. WorkRecovery.tsx로 복구 패널을 분리하고 WorkRoom.tsx에 연결한다. recoveryMessages.ts에 기존 지원 언어인 한국어·영어를 작성한다.
4. 관련 테스트와 전체 빌드, 데스크톱 테스트 및 내장 브라우저·격리 Windows 앱을 검증한다. 새로운 문제를 수정한 경우 해당 검증을 다시 실행한다.
5. 기존 독립 배포 저장소의 v0.1.2 소스에 이번 변경 파일만 반영한다. v0.1.3으로 설치형·무설치판을 빌드하고 소스·파일 해시를 검증한 뒤 새 GitHub 릴리스를 게시한다. 사용자 앱·13003 서버는 재시작하지 않는다.

명령은 프로젝트 scripts/node.ps1 및 scripts/npm.ps1을 사용한다. 진행은 OpenSpec tasks.md에 반영한다. 자동 테스트는 데이터·Codex fixture를 분리하며 실사용 대화에 AI 메시지를 보내지 않는다.
