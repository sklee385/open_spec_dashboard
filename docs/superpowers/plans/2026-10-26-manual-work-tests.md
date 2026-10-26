# 작업 테스트 / 전체 테스트 구현 계획

**Goal:** 개발 중 반복 검증을 줄이고 사용자가 두 범위의 테스트를 직접 실행한다.

**Architecture:** ExecutionService의 명령·결과 저장을 재사용한다. 작업 범위 명령 탐지와 AI 정책은 독립 모듈로 분리한다. WorkRoom은 일괄 실행 API와 결과 컴포넌트를 사용한다.

**Tech Stack:** NestJS, React, TypeScript, Vitest.

- [x] `backend/test/manual-tests.test.ts`: 작업/전체 명령 분리, 순차 성공, 실패·중단·중복 차단, 기존 결과 최신성 확인. `./scripts/npm.ps1 run test:run --workspace backend -- test/manual-tests.test.ts`로 실패 확인 후 구현한다.
- [x] `backend/src/work/test-commands.ts`: package.json의 Vitest 스크립트와 npm workspace 목록을 읽어 변경 관련 명령을 생성한다. `ExecutionService.commands(work, 'work')`와 범위별 계획·실행·결과를 연결한다. `POST /work/:id/verify-all`은 `{scope:'work'|'full'}`을 받는다.
- [x] `backend/src/work/testing-instructions.ts`: 최소 검증 정책을 두 AI 어댑터의 매 요청에 포함한다.
- [x] `frontend/src/components/WorkTests.test.tsx`: 두 버튼, 범위별 상태, 재검증 안내, 실패 수정 요청을 검증한다. 새 컴포넌트와 WorkRoom 연결 및 한국어·영어 문구를 구현한다.
- [x] 관련 테스트와 양쪽 타입 검사를 실행한다. 내장 브라우저로 버튼과 결과 화면을 확인하고 API 문서를 갱신한다.
- [x] 변경 전 스냅샷과 최종 파일을 비교하여 이번 변경만 인덱스에 반영하고, staged diff를 검토한 뒤 한국어 상세 메시지로 커밋한다.

검증 기록: 서버 관련 58개, 작업 명령 보완 후 5개, 화면 관련 43개 통과. 실제 npm exec 관련 테스트 선택 명령으로 94개 통과. 양쪽 TypeScript 검사 통과. 기존 미커밋 변경을 제외한 커밋 후보만 별도 폴더에 구성하여 양쪽 타입 검사와 서버 5개·화면 14개 테스트도 통과했다. 내장 브라우저에서 계획 단계의 테스트 실행 차단 및 두 범위의 미검증 표시를 확인했다. 전체 프로젝트 검증은 실행하지 않았다.
