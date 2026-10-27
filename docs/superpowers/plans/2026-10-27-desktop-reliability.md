# 데스크톱 안정성 및 배포 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 사용자는 설계와 정식 배포를 승인했다. 기존 수정이 있는 현재 개발 브랜치에서 계속하고 관련 경로만 선택적으로 커밋한다.

**Goal:** Windows 검은 화면과 과거 기록으로 인한 업데이트 차단을 예방하는 다음 정식 버전을 게시한다.

**Architecture:** 그래픽 기본값과 화면 장애 복구를 별도 모듈로 두고 기존 메인 프로세스와 준비 IPC에 연결한다. 대화 서버와 업무 저장 상태는 화면 재로드로부터 독립적으로 유지한다.

**Tech Stack:** Electron 45, Node 24.15, Node test, Vitest, GitHub Actions.

## 작업

- [x] 1. `desktop/test/graphics.test.cjs`에 OS 기본값 및 손상된 설정 회귀 검사를 먼저 추가한다. `./scripts/node.ps1 --test desktop/test/graphics.test.cjs`의 실패 후 `configureGraphics(app, directory, platform=process.platform)`를 수정하고 통과를 확인한다.
- [x] 2. `desktop/test/renderer-recovery.test.cjs`에 EventEmitter 창·네이티브 대화상자·수동 타이머를 사용하여 실패·지연·취소·중복·재로드·종료 보호 검사를 추가한다. `RendererRecovery`의 `loading()`, `ready()`, `report(reason)`, `dispose()`를 구현한다. `report`는 명시적 재로드 선택만 실행하고 오류 재시도는 반복하지 않는다.
- [x] 3. `desktop/main.cjs`에 준비 IPC 및 로드/충돌/응답 없음 이벤트를 연결하고 `scripts/desktop-stage.cjs`의 모듈 포함 목록을 갱신한다. `desktop/test/security.test.cjs`에서 실제 main의 장애 이벤트가 서버를 종료하지 않는지 확인한다. 무설치 준비 완료는 준비 IPC 뒤에 보고한다.
- [x] 4. 기존 `backend/src/desktop/lifecycle.ts`와 `backend/test/desktop-lifecycle.test.ts`의 과거 기록 예외를 포함하고, 실제 질문·승인·메시지·검증·요청의 차단 및 레코드 보존을 재검사한다. `docs/PORTABLE.md`, `docs/DESKTOP.md`에 기본값과 복구 동작을 설명한다.
- [x] 5. `./scripts/npm.ps1 run desktop:test`, `./scripts/npm.ps1 test`, `./scripts/npm.ps1 run build`를 실행한다. 실패는 원인을 재현해 수정한다. 별도 검토 에이전트가 제품 diff와 요구사항을 확인하고 중요한 문제는 배포 전에 해결한다.
- [ ] 6. 원격 최신 버전을 재확인하여 package·lock 버전을 올린다. 관련 파일만 한국어 커밋으로 기록한다. 일반 푸시와 새 버전 태그로 기존 CI를 실행한다. 실패 시 기존 태그·릴리스를 덮어쓰지 않는다.
- [ ] 7. Windows CI 검사·설치형·ZIP 생성·해시 검증·정식 게시가 완료될 때까지 확인한다. 공개 릴리스 파일 목록과 메타데이터를 재검증하고 URL을 사용자에게 제공한다. 인증이나 환경의 외부 제한이 생기면 완료된 구현·검증과 남은 작업을 구분해서 보고한다.
