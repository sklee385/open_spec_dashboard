# Proposal

## Why
OpenSpecBoard의 app-server는 Codex 데스크톱 내장 브라우저를 공유하지 않는다. 사용자의 다른 PC 작업을 방해하지 않으면서 실제 웹 화면을 재현 가능하게 검증할 전용 실행기가 필요하다.

## What Changes
- 로컬 테스트 서버를 업무의 격리 작업 경로에서 실행하고 전용 headless Chromium으로 검증한다.
- 사용자가 저장한 시나리오만 실행하고, AI는 실행·상태 조회·중단만 요청한다. 첫 버전의 탐색은 실패 화면과 구조화 결과 조회로 제한한다.
- 실행 전후 코드 버전, 단계별 판정, 화면 증거와 중단·차단 상태를 보존한다.
- 기존 대화와 질문 도구를 유지하며 브라우저 실행은 하나로 제한한다.
- OpenSpecBoard 전용 실행기는 내장 브라우저 전용 지침의 명시적 예외로 추가한다. Edge 확장과 별도 브라우저 MCP는 사용하지 않는다.

## Capabilities
### New Capabilities
- `browser-verification`: 전용 브라우저의 접근 경계, 시나리오, 증거, 수명 관리와 배포.
### Modified Capabilities
없음. 기존 개발 검증·사용자 완료 확인 요구사항은 유지한다.

## Impact
backend 브라우저 서비스·Codex 도구·종료 가드, frontend 업무 검증 화면, Chromium 설치·패키징, 개발 지침 및 README. Playwright 라이브러리를 고정 버전으로 추가한다. 실제 세션 서버 재시작은 작업과 승인 대기가 모두 끝난 뒤 별도 수행한다.
