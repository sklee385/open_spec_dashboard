# Read-only Daily Dashboard Implementation Plan

> **For agentic workers:** Execute proportionately in the current session. Use subagents only when authorized and useful for substantial independent work. Use checkbox steps when tracking helps.

**Goal:** 여러 업무의 선택 날짜 주요 활동과 확인된 현재 상태를 읽기 전용으로 비교하고 원문으로 이동한다.

**Architecture:** 기존 SQLite events를 날짜별 SQL 집계/페이지 조회한다. 기존 runtime probe의 active/unknown/inactive 근거와 pending 질문을 현재 상태로 따로 표시한다. 과거 활동을 현재 상태로 재구성하거나 업무 상태를 변경하지 않는다.

**Tech Stack:** NestJS, node:sqlite, React, 기존 i18n/CSS, Vitest, Codex 내장 브라우저.

## 계약과 화면 결정

- `GET /api/daily?date=YYYY-MM-DD&zone=Asia/Seoul|UTC&sourceId=&bucket=activity|carryover&page=1&limit=25`.
- 선택 날짜의 고유 업무·명시 완료와 현재 실행·확인 대기·오류·확인 필요를 구분한다. 대기/실패/불명/진행이 선택 날짜 이전부터 남아 있으면 별도 목록에 표시한다. 시각 근거가 없으면 기록 없음으로 둔다.
- `GET /api/daily/:workId/events?date=&zone=&scope=day|all&before=&limit=30`: 주요 이력만 정방향 원문 seq를 유지하며 역순 페이지 조회한다. cursor는 마지막 반환 seq이며 이전 페이지의 항목을 재반환하지 않는다.
- 대화 조각·heartbeat·재연결 통지를 활동 수로 세지 않는다. 동일 turn/item의 완료 재통지는 첫 기록 기준으로 중복 제거한다. 사용자 메시지/명시 완료/문서 저장/검증/질문 응답은 별도 주요 활동이다. AI 턴 완료는 업무 완료가 아니다.
- UTC 저장값을 수정하지 않는다. 첫 버전 표시 시간대는 한국(UTC+09:00)과 UTC이며 선택 날짜 경계를 서버에서 계산한다. 없는 시간은 추정하지 않는다.
- 기존 대화 표시에서도 seq 중복과 동일 item 완료 재통지를 합치고 첫 메시지 timestamp를 보존한다. 사용자 선택 원문 seq를 해당 메시지로 이동시킨다.
- 화면 질문: ‘그날 어떤 업무를 했고, 지금 무엇이 확인을 기다리는가?’ 기존 OpenSpecBoard 헤더/폰트/색을 유지한 achromatic-ledger, 실제 수치의 분리된 요약과 활동/현재 상태의 병렬 열, 원문 이동을 핵심 동작으로 한다. 시각효과·장식 차트·가짜 숫자는 없다.
- 자동 상태 변경, 실행/재실행, AI 요약, 생산성 점수, 과거 데이터 보정, 새 배포는 제외한다.

## 구현 순서

- [x] `backend/src/work/daily-events.ts`: 주요 이벤트/재통지 식별 SQL을 공유한다. first-event만 포함해 날짜 경계를 넘는 재연결 중복도 방지한다.
- [x] `backend/src/work/daily-dashboard.ts`: 날짜/zone/page/cursor 검증, 날짜 집계·현재 근거·carryover·bounded history GET controller. `store.ts`에 읽기 인덱스만 추가하고 `app.ts`에 controller/provider를 등록한다.
- [x] `backend/test/daily-dashboard.test.ts`: UTC 경계, AI 종료≠명시 완료, 고유 작업/회차, 중복 재통지, missing timestamps, pending/unknown 실제 근거, carryover, history cursor, 잘못된 query와 읽기 전용 불변을 실제 SQLite로 검사한다. 기존 코드/조건과 같은 성공 검사는 재사용한다.
- [x] `frontend/src/lib/workConversation.ts`와 관련 단위 검사: 첫 시각·중복 seq/item·stream 완료를 일관되게 합친다. `WorkRoom.tsx`는 저장된 timestamp와 요청 seq 이동을 표시한다.
- [x] `frontend/src/components/DailyDashboard.tsx`/CSS/types/i18n: 날짜/시간대, 분리 요약, 두 목록, 주요 이력과 이전 페이지, 오류/빈 상태/취소·오래된 응답 배제. `Header.tsx`, `App.tsx`에 읽기 전용 진입과 기존 draft guard를 지키는 원문 이동을 연결한다.
- [x] 관련 backend/frontend 검사와 양쪽 build, 새 격리 fixture에서 Codex 내장 브라우저의 날짜/이력/원문/모바일 동선을 확인한다. 13003·현재 실행 앱·다른 업무는 유지한다. 브라우저 도구의 한계가 있으면 실제 미실시 범위를 명시한다.

검사 명령은 전용 런타임으로 `vitest run test/daily-dashboard.test.ts`와 frontend 새 component/helper 및 직접 영향 WorkRoom/Header/App 선택 검사만 실행한다. 전체 suite/새 공개 릴리스/실제 앱 재업데이트는 실행하지 않는다. 별도 `codex/readonly-daily-dashboard` 브랜치에서 한국어 커밋으로 결과를 남긴다.

최종 결과: backend 8개·frontend 76개(매개변수 사례 포함) 직접 영향 사례 통과, 양쪽 빌드 통과, Codex IAB 동선과 기본 desktop/768/390 화면 확인. 마지막 활동을 오류·실행 시작 시각으로 추정하지 않으며 pending 생성 시각 외 시작 근거가 없으면 확인 필요로 표시한다. 새 CI/공개 배포/현재 앱 업데이트는 하지 않았다. 전체 suite는 미실시다.
