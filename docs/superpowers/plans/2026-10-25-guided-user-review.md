# 사용자 검토 진행 구현 계획

**Goal:** 사용자 검토 진행 버튼으로 최신 검토 항목을 같은 AI 대화에서 한 개씩 질문한다.

**Architecture:** 기존 action API에 `guided-review`를 추가한다. ReviewService에서 최신 문서를 추출하고 Codex의 구조화 질문 흐름을 재사용한다. 프런트엔드는 기존 초안 보호 및 오류 처리에 연결한다.

**Tech Stack:** NestJS, React, TypeScript, Vitest.

## 1. 서버 동작

- [x] `backend/test/guided-review.test.ts`에 실제 임시 문서와 API를 사용하는 테스트를 추가하고 실패를 확인한다.
- [x] `backend/src/work/work.service.ts`에 ReviewService를 주입하고 `guided-review` 동작을 추가한다. 현재 실행·응답 대기·완료·복구 상태와 도구 기능을 검증한다.
- [x] 최신 문서 조회 후 상태를 재확인한다. 시작 잠금을 사용해 병렬 요청이 실행을 중복 시작하지 않도록 한다.
- [x] `backend/src/review/instructions.ts`에 검토 지침 생성 함수를 추가한다. 문서 순서·항목 위치·버전과 전체 항목을 JSON 자료로 전달하고 한 질문→답변→문서 반영→다음 질문 흐름을 지시한다.
- [x] 검토 없음·문서 읽기 실패는 AI 실행 없이 오류를 안내한다. 검토 완료 표시는 자동 확정하지 않는다.
- [x] `./scripts/npm.ps1 run test:run --workspace backend -- test/guided-review.test.ts`로 검증한다.

## 2. 업무 화면

- [x] `frontend/src/components/WorkRoom.test.tsx`에 버튼 위치·요청·초안 보호·실행 상태와 외부 도구 제한 테스트를 먼저 추가한다.
- [x] `frontend/src/components/WorkRoom.tsx`에서 계획 버튼 바로 뒤에 `action('guided-review')` 버튼을 추가한다. 사용 가능 여부와 비활성화 이유를 표시하고 시작 후 대화 화면을 연다.
- [x] `frontend/src/i18n/catalog.ts`에 한국어·영어 버튼 및 안내 문구를 추가한다.
- [x] `./scripts/npm.ps1 run test:run --workspace frontend -- src/components/WorkRoom.test.tsx src/i18n/contracts.test.tsx`로 검증한다.

## 3. 확인 및 전달

- [x] 관련 서버·화면 테스트와 양쪽 빌드를 실행한다.
- [x] `docs/API.md`, `docs/USAGE.md`에 새 동작을 문서화한다.
- [x] Codex 내장 브라우저로 화면을 확인한다. 기존 세션이 실행·응답 대기 중이면 세션 서버 재시작을 하지 않고 반영 대기임을 안내한다.
- [x] 변경을 직접 검토하고 결과를 보고한다. 사용자 요청 없는 커밋·브랜치 생성은 하지 않는다.

## 검증 결과

- 서버 관련 53건, 화면·문구 관련 40건 통과. 백엔드·프런트엔드 빌드 통과.
- 독립 리뷰에서 메시지 상한 초과를 발견해 재현 테스트 후 보완했다. 검토 자료가 80,000자를 넘으면 항목 수와 전체 원문 조회 지침을 전달해 기존 100,000자 제한 안에서 검토를 시작한다.
- Codex 내장 브라우저에서 버튼 위치·활성 상태 확인. 실제 사용자 업무의 검토를 임의 실행하거나 질문에 대신 답변하지 않았다.
