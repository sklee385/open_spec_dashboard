# Desktop Health and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development with independent file ownership and spec/code review. 사용자가 전체 설계 범위와 커밋·배포를 승인했다.

**Goal:** 앱이 멈추거나 실제 실행과 저장 상태가 다를 때 상태를 점검·복구·종료할 수 있도록 한다.

**Architecture:** 백엔드 실행 판정·복구 API, 기존 UI 초안 보존, 데스크톱 전용 진단 창·독립 종료 도구를 분리한다. 점검은 읽기 전용이고 실제 복구·중단·강제 종료는 선택과 소유권 재검증을 요구한다.

**Tech Stack:** NestJS/TypeScript/SQLite, React, Electron, Node 24.15, Windows PowerShell, Vitest/Node test.

## 구현 계약

진단 API는 기존 desktop 인증 경계 안에서 GET `desktop/diagnostics`, POST `desktop/recover/:id`, POST `desktop/interrupt/:id`, POST `desktop/safe-mode`를 제공한다. 안전 모드 POST body는 `{enabled:boolean}`다. 진단 응답은 `{checkedAt,safeMode,idle,locked,requests,works,history,requestDetails}`이며 works는 `{id,name,state,phase,runtime,status,reasons,updatedAt,canRecover,canInterrupt}`다. runtime은 active/inactive/unknown, status는 normal/running/mismatch/unknown이다. 문자열 목록 reasons는 UI에 표시할 한국어이며 사용자 원문을 포함하지 않는다. root 진단 창은 이 계약만 소비한다.

독립 종료 모듈은 `captureOwner({appDirectory,userDirectory,pid,childPid})`, `terminateOwner({ownerPath,confirm})`를 Node export로 제공하고 Windows에서는 프로세스 생성 시각과 실행 파일 경로를 검증한다. 부모 앱과 보조 도구가 같은 트리에 있을 때 도구 자신은 종료하지 않는다. `captureOwner`는 경로 또는 소유 레코드 메타데이터를 반환한다. 구현 중 계약 조정은 root와 공유한다.

## 작업

- [x] 1. 백엔드: 실행 등록부·안전 모드·진단 사건 기록과 API를 구현한다. Codex 연결 해제 대상을 실제 영향을 받은 업무로 제한하고 종료 유휴 판정에서 실행과 복구 필요 상태를 분리한다. POST 복구는 새 실행과 경합하지 않도록 동기 검사·변경한다. 기존 인증·질문·승인·프로젝트 잠금 검사를 유지한다. 실패 테스트 후 최소 구현하고 관련 Vitest를 통과시킨다.
- [x] 2. 초안: WorkRoom 메시지·답변·문서와 ProjectWorkspace 편집 내용을 지속 저장하고 재로드 복원·버전 충돌·실패 알림을 구현한다. 저장 성공·명시적 폐기만 해당 초안을 제거한다. React 재렌더링·업무 전환 시 다른 초안을 덮어쓰지 않는 회귀 검사를 추가한다.
- [x] 3. 독립 긴급 종료: 앱·서비스 소유 정보를 기록하고 경로·PID·생성 시각 검증을 거친 종료 모듈과 실행 진입점을 만든다. 사용자 명시적 확인이 없으면 종료하지 않는다. 비정상 종료 표시를 보존하고 다른 앱·PID 재사용·손상 레코드를 거절하는 단위/격리 프로세스 검사를 수행한다.
- [x] 4. 데스크톱 통합: 별도 진단 창·고정 IPC·메뉴·트레이, 오류 유형 구분, 정상 종료 뒤 강제 종료 선택, 비정상 시작 안전 모드, 사건 기록을 연결한다. 진단/복구 API timeout과 명시적 동작 확인을 유지한다. 새 모듈·도구를 설치형/ZIP 스테이징에 포함한다.
- [x] 5. 테스트·검토: 관련 검사 후 desktop 전체, 프런트엔드/백엔드 전체와 빌드를 수행한다. 독립 에이전트가 요구사항과 안전성을 검토하고 중요한 문제를 수정한다. 별도 프로필의 실제 패키지에서 점검·복구·안전 시작·정상 및 강제 종료를 확인한다. 브라우저 검증은 Codex 내장 브라우저를 사용한다.
- [ ] 6. 배포: 원격 최신 버전·main을 확인하여 다음 정식 버전을 선택하고 관련 경로만 한국어 메시지로 커밋한다. 새 태그로 기존 CI를 실행하고 정식 게시가 끝날 때까지 확인한다. 과거 태그·릴리스는 덮어쓰지 않는다. 설치형·ZIP·메타데이터의 공개 파일과 해시를 검증하고 기록한다.
