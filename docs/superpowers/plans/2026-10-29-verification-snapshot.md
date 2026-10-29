# 검증 사본 실행 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox tracking.

**Goal:** 진행 중인 대화의 쓰기 점유를 빼앗지 않고 별도 사본에서 검증하며 변경된 원본의 결과를 무효화한다.

**Architecture:** 서버가 업무 ID에서 원본을 해석하고 AI 쓰기 범위 밖에 독점 사본을 생성한다. 원본/사본의 복사 전후 바이트 식별을 확인하고 기존 호스트 실행기와 새 테스트 데이터로 실행한다. 종료·세대·시나리오·소스 검사 후에만 결과를 확정한다.

**Tech Stack:** TypeScript, Node fs/crypto, Nest, Vitest, 기존 BrowserService/Windows Job 가드.

승인: 2026-10-29 사용자가 질문 답변으로 “검증 사본 방식으로 변경하고 개발 진행 (권장)”을 선택했다. 같은 방식의 문서 재승인을 반복 요청하지 않는다. OpenSpec의 기존 4.5를 수행하며 후보 출처/빌드 계약은 기존 그룹 7 범위다.

## Task 1: 사본 생성·식별

Files: `backend/src/browser/verification-snapshot.ts`, `backend/test/verification-snapshot.test.ts`.

- [x] 실제 임시 파일을 사용하여 독립 복사·바이너리·권한·원본 변경·사본 변경·링크·경로 겹침·비밀 파일 제외 테스트를 먼저 작성한다.
- [x] `./scripts/npm.ps1 run test:run --workspace backend -- verification-snapshot`으로 기능 부재 실패를 확인한다.
- [x] 호스트 전용 사본 모듈을 구현한다. 독점 컨테이너 생성, 모든 활성 업무 원본/실행 경로 양방향 겹침 거부, 링크/공유 파일 거부, 원본과 사본 raw digest 대조를 적용한다.
- [x] 같은 명령으로 통과를 확인하고 삭제는 소유 컨테이너에만 제한하는지 검토한다.

## Task 2: 실행 서비스 연결

Files: `backend/src/browser/browser.service.ts`, `backend/test/browser-snapshot-service.test.ts`, 기존 browser test fixture. 비동기 최신성 조회 전파: `backend/src/work/work.controller.ts`, `backend/src/work/work.service.ts`, `backend/src/desktop/lifecycle.ts`.

- [x] 가짜 fork/Job 가드와 실제 파일 사본으로 worker 전달 root가 원본과 다른지, tool owner가 running 상태/대화/턴을 유지하는지, status/cancel과 다른 업무 실행이 유지되는지 테스트한다.
- [x] `./scripts/npm.ps1 run test:run --workspace backend -- browser-snapshot-service`의 실패를 확인한다.
- [x] 기존 시나리오 검사를 마친 후 사본을 준비하고 실행기에 사본 root만 전달한다. 결과에 사본 환경 ID와 원본 식별/대화/턴/시나리오/소스 버전을 저장한다. 실제 가드 종료 후 원본/사본/시나리오/세대 변경은 stale, 종료 불명은 blocked·사본 보존으로 처리한다.
- [x] 큰 파일/의존성의 사본 복사와 식별 검사는 비동기 I/O로 실행하고 파일/총량 제한을 읽기 전에 검사한다. 실행 슬롯은 첫 await 전에 예약한다. 준비 중 cancel도 AbortSignal로 처리하며 실패 시 예약·결과·업무 상태를 정리한다. 비동기 완료 검사를 기다린 뒤에는 최신 업무 상태와 검토/소스를 다시 검사한다.
- [x] 위 테스트와 기존 browser-service/mailbox/API 회귀를 실행한다. DATA_DIR는 실제 사본 소유 경계 조건에 맞게 원본 밖의 임시 형제 경로를 사용한다.

## Task 3: 리뷰·검증·기록

- [x] 명세 준수 검토와 코드 품질 검토를 각각 수행하고 중요한 문제를 수정한다.
- [x] `./scripts/npm.ps1 run build --workspace backend`, `./scripts/node.ps1 node_modules/@fission-ai/openspec/bin/openspec.js validate add-git-worktree-workspaces --strict`, `git diff --check`를 실행한다.
- [x] 실제 결과를 implementation-notes.md에 기록한 후에만 4.5를 체크한다. 운영 앱/13003 서버를 재시작하지 않는다.
- [ ] 관련 변경만 한국어 커밋으로 저장하고 기존 계획의 4.6을 이어간다. 모든 54개 완료나 배포 성공으로 확대 보고하지 않는다.
