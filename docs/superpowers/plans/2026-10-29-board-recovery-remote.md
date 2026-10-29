# Board 잠금 복구 및 모바일 원격 연결 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Review backend contracts before integrating UI and run verification before release.

**Goal:** 외부 대화 점유가 Board 전체를 막지 않게 하고, 새 세션 복구와 모바일 Codex에서 호출 가능한 로컬 연결 도구를 제공한다.

**Architecture:** 업무별 Codex 연결을 분리하고 실행 상태와 외부 점유를 구별한다. 복구 인계 자료와 명령 ID를 영속 저장하며 이전 실행 불명확 시 변경 작업을 차단한다. 원격 도구는 인증된 로컬 전용 연결을 통해 기존 업무 API의 검토·승인 규칙을 재사용한다.

**Tech Stack:** NestJS, TypeScript, SQLite, React, Node CLI, Electron, Vitest, GitHub Actions.

## 1. 세션 복구와 연결 격리

Files: backend/src/codex/client.ts, codex.service.ts, 신규 복구 모듈; backend/src/work/recovery.ts, work.controller.ts; backend/src/ai-tools/ai-tool.service.ts; backend/test/codex*.test.ts.

- [x] 외부 writer 충돌, 업무별 연결 손실, 기존 active/unknown 실행에 대한 회귀 테스트를 먼저 작성한다.
- [x] 업무별 client와 세대 검사를 도입한다. 첫 업무의 기존 client 테스트 접근은 호환하며 다른 업무는 별도 프로세스로 격리한다.
- [x] POST work/:id/recover-session {requestId}를 추가한다. 복구 상태는 prepared/creating/completed/uncertain/blocked, 인계 자료는 session-recovery-context 레코드에 저장한다.
- [x] 이전 대화 조회와 실행 종료 증거를 확인한다. 불명확하면 자료 준비만 허용한다. thread/start 후 자동 turn/start를 금지하고 다음 사용자 지시 때 인계 자료를 전달한다.
- [x] 기존 세션 관계, 파일·Git·OpenSpec 상태, 미완료 작업을 보존한다. 생성 응답 불명확 시 같은 요청으로 새 세션을 다시 만들지 않는다.
- [x] Run ./scripts/npm.ps1 run test:run --workspace backend -- codex 및 backend 빌드. 충돌 복구와 기존 실행 보호 테스트가 모두 통과해야 한다.

## 2. 모바일 Codex용 로컬 연결 도구

Files: backend/src/remote/**, backend/src/app.ts, backend/scripts/board-remote.cjs, backend/test/remote*.test.ts.

- [x] 인증 거부, 외부 Origin 거부, 동일 명령 중복 실행 방지, 충돌 payload, 재시작 후 uncertain 처리 테스트를 먼저 작성한다.
- [x] 127.0.0.1 전용 서버와 별도 비밀을 사용한다. DATA_DIR 연결 파일은 도구가 읽고 출력에는 비밀을 포함하지 않는다.
- [x] GET /api/remote는 available/connectionPath/cliPath/nodePath/transport/mobileVerified만 반환한다.
- [x] POST /commands {requestId,workId,action,body}는 영속 명령 ID를 즉시 반환한다. list/status/command-status와 message/answer/approval/interrupt/reconnect/recover-session CLI를 제공한다.
- [x] 기존 WorkController 경로를 호출하여 검토·승인·실행 조건을 유지하고, DesktopLifecycle에 실제 진행 중 요청을 등록한다. 재시작 후 이전 명령 자동 재실행을 금지한다.
- [x] Run ./scripts/npm.ps1 run test:run --workspace backend -- remote 및 backend 빌드. 인증·명령 상태·라이프사이클 검증이 통과해야 한다.

## 3. 업무 UI와 안내

Files: frontend/src/components/WorkRoom.tsx, SessionRecovery.tsx, RemoteBoardConnection.tsx 및 관련 테스트/스타일; docs/REMOTE.md.

- [x] 기존 WorkRoom 테스트와 같은 API fixture로 복구 버튼, 차단 이유, 복구 전/후 세션 ID, 비밀 없는 원격 연결 명령 표시를 검증한다.
- [x] 복구 전 입력 초안을 보존하고 requestId를 재사용한다. API 시간 초과 이후 새 요청을 만들지 않고 같은 복구 상태를 조회한다.
- [x] 인계 자료와 새 세션이 대화 복제가 아님을 안내한다. 복구가 blocked/uncertain이면 새 실행을 가능하다고 표시하지 않는다.
- [x] 원격 연결 도구 경로와 사용법, PC 온라인·Codex 원격 연결 필요 조건, 실제 모바일 검증 미실시 여부를 표시한다.
- [x] Run ./scripts/npm.ps1 run test:run --workspace frontend 및 frontend 빌드.

## 4. 통합 검토와 배포

Files: package.json, package-lock.json, docs/DESKTOP.md, docs/PORTABLE.md, release notes.

- [x] 구현을 설계와 대조하고 별도 코드 리뷰로 실행 종료 증거·오래된 알림·중복 명령·인증을 확인한다.
- [x] 모든 backend/frontend/desktop 테스트와 빌드를 실행한다. Codex 내장 브라우저로 격리 fixture 업무 UI를 확인한다. 운영 13003 서버를 재시작하지 않는다.
- [x] 포터블 패키지에 CLI와 신규 모듈이 포함되는지 확인하고 버전을 0.1.14으로 올린다.
- [x] 이번 변경 파일만 상세 한국어 메시지로 커밋하고 push/tag한다. 기존 사용자 OpenSpec 문서 변경은 제외한다.
- [x] GitHub 릴리스 빌드·패키지 검증·게시 성공과 업데이트 manifest를 확인한다. 실제 모바일 검증이 불가능하면 명확히 보고한다.

## 검증 기록

2026-10-29 로컬 최종 검증: backend 375개 통과·환경 조건 2개 생략, frontend 283개 통과, desktop 201개 통과. 프런트엔드·백엔드 빌드와 격리 동봉 서비스의 유휴 종료·미처리 업무 종료 차단·백업·복원 smoke를 통과했다. 제한 환경의 브라우저 프로세스 종료 확인 실패는 일반 실행 환경에서 재검증했다.

Codex 내장 브라우저에서 별도 fixture 업무의 외부 점유 오류 → 새 세션 준비 완료와 모바일 연결 안내를 확인했다. 설치된 Codex 바이너리와 실제 CodexService로 별도 CODEX_HOME의 합성 완료 대화를 복구하여 새 대화 ID·동일 작업 폴더·인계 자료 보존·동일 요청 중복 방지·자동 turn 미실행을 확인했다. 사용자 인증을 복사하거나 실제 대화를 변경하지 않았다. 실제 휴대전화 페어링 및 모바일 왕복은 검증하지 않았다.

추가 native 호환성 검사에서 첫 턴이 없는 새 대화는 저장 확정 전 연결이 종료되면 재개할 수 없음을 확인했다. v0.1.13 배포는 게시 전에 취소했으며 태그와 실행 이력을 보존했다. v0.1.14는 대화 이름 저장 API로 모델 실행 없이 대화를 영속화하고, 실제 서비스 종료·재생성 후 동일 새 세션 재개를 확인했다. 이름 저장 실패는 생성 ID와 uncertain 상태를 보존하여 중복 생성하지 않는다.

## 공개 배포 확인

- 공개 버전: [v0.1.14](https://github.com/sklee385/open_spec_dashboard/releases/tag/v0.1.14), 2026-10-29 게시, 최신 정식 릴리스 확인.
- 소스 커밋: `2883f663a6849b291656515cbe1d2fbc8627057c` (기능 구현 `76398f4` 포함).
- [배포 실행 40845515507](https://github.com/sklee385/open_spec_dashboard/actions/runs/40845515507): build/release 성공. desktop 201개, frontend 283개, backend 377개 통과·환경 조건 2개 생략, 총 861개 통과.
- 실제 Electron 렌더러 격리·트레이·화면 충돌 복구·진단 창·안전 모드·강제 종료 후 SQLite 및 초안 복원·ASAR 무설치 업데이트와 후보 v0.1.14 재시작 검사 통과.
- 인증 없는 공개 다운로드로 설치 파일 380,472,756바이트, ZIP 478,041,425바이트, blockmap 394,804바이트를 재검증했다. GitHub 자산 SHA-256, 설치 파일 및 ZIP의 업데이트 정보 SHA-512, latest.yml/portable.json의 버전·파일·크기·해시가 일치했다.
- ZIP SHA-512: `XEUNJjZnp9Q53hSt5IUaa4HEE7apqEEBOmfHPjA1yWthIcdo075uOHF+yGzGfr+jXRa+NitEUlVL/0buAObb9Q==`.
- 사용자 실행 앱의 설치 경로를 교체하거나 운영 세션을 재시작하지 않았다. 실제 모바일 페어링·원격 왕복은 별도 검증 대상이다.
