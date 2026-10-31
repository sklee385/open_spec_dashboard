# 변경 영향 검증과 정확한 증거 재사용 Implementation Plan

> **For agentic workers:** 승인된 최소 개선을 현재 C 사본에서04537c9 이후 별도 커밋 경계로 구현한다. 하위 에이전트와 새 전체 검사/사전 CI를 만들지 않는다. 변경 관련 최소 검사만 사용한다.

**Goal:** 변경 영향에 맞는 명시적 검증 계획을 만들고 정확히 같은 성공 근거만 재사용하며 현재 fresh 실패만 기본 수정 입력에 넣는다.

**Architecture:** test-commands는 실제 runner/build 설정과 기능 config를 구분하고 sources+직접 test를 한 Vitest related 요청으로 합친다. ExecutionService의 requiredPlan을 업무 완료와 후보가 공통 사용한다. 사용자 전체/작업 선택은 저장하고 후보는 독립 선택과 이유를 표시한다. 실행은 기존 소유 Job runner로 끝내고 source/command/runtime·환경/target/종료 schema의 일치만 cache 성공으로 인정한다. 후보 근거는 동일 후보 version/명령/환경/종료에서만 재사용하며 업무 결과를 빌리지 않는다.

**Tech Stack:** TypeScript/Nest/React, 설치된 Vitest4의 related 자체 파일 포함 규칙, 기존 Windows HANDLE/Job, SQLite 기록.

## 경계

- 기존 CI41249773899는 head8193bac로 계속 관찰한다.04537c9 fixture 수정과 새 제품 변경의 성공으로 계산하지 않는다.
- 오래된/근거 없는 성공·최신 실패/미확인 종료를 재사용하지 않는다. 같은 명령의 과거 성공으로 현재 실패를 숨기지 않는다.
- 모든 환경 값은 hash만 기록한다. 인증값이나 사용자 데이터는 응답/공개 Git에 넣지 않는다. 원본D와 별도a16fa882를 변경/통합하지 않는다.
- CI 게이트는 제거하지 않는다. 이전 성공의 소스 SHA/검증 artifact가 새 최종 커밋과 다르므로 빌드 결과를 재사용하지 않는다. 새 최종 릴리스 커밋의 필수 CI1회만 계획하고 추가 workflow_dispatch를 만들지 않는다.

## 작업

- [x] 실제 runner/build 설정 변경의 넓은 검사와 기능 config의 related를 구분한다. related+run을1개 요청으로 합치고 동일 command를 중복 실행하지 않는다.
- [x] 공통 검증 계획/명시 선택/이유를 업무 완료·후보 preview/run에 연결한다. 명령이 없으면 전체로 자동 확대하지 않고 사용자 선택이 필요함을 표시한다.
- [x] 업무 실행을 소유 Job runner로 연결하고 엄격한 현재 evidence freshness/cache·정상 종료를 저장한다. 후보는 동일 후보 version과 현재 성공/종료만 재사용한다.
- [x] fresh 최신 실패만 수정 입력에 사용하고 stale 결과는 이력으로 보존한다. 계획 이유/선택/재사용을 현재 UI에 최소 추가한다.
- [ ] 변경 관련 단위/회귀/API·빌드만 확인하고 provenance·계획을 커밋한다. 현재 CI 최종 실패를 별도로 분류한다.
- [ ] 최종 커밋 배포 CI1회·정식 정책/필수asset 검증 후 공개하고, 기존 백업 이후 변경을 재확인하여 지정 portable만 업데이트·버전/데이터 보존 대조한다. 새 권한/보호 승인 차단은 정확히 보고한다.

## 구현과 관련 검증 (2026-11-01)

기본 작업 범위·명시 전체 선택과 이유를 업무 완료/통합 예약/후보 검증에 연결했다. 실제 runner config와 literal setup/import 입력만 넓게 검사하며 기능 config는 related로 처리한다. package.json의 version만 바뀐 경우 넓은 자동 검사를 만들지 않는다. Vitest related에 직접 test 파일도 함께 전달하여 중복 실행을 없애고 사용자 명령도 같은 실행 파일/인자 조합을 한 번만 실행한다. 후보 범위 선택은 현재 Work 정책/요청 hash CAS와 동일 요청 키 재생으로 저장한다.

업무 검증도 기존 소유 Job runner를 사용한다. 새로운 성공 근거는 source mutation/revision, 실제 공간, 원시 소스와 private 입력 hash, 실제 환경 hash, 실행 파일/runtime hash, 명령 및 정상 Job/worker 종료가 일치해야 현재 결과로 인정한다. 값이나 private 본문은 기록/응답하지 않는다. 최신 실패나 종료 미확인이 있으면 과거 성공을 찾아 재사용하지 않는다. 종료 미확인은 건강 상태에 남기고 PID 추정으로 해제하지 않는다. 후보는 같은 candidateVersion과 정확한 명령/정상 종료의 최신 성공만 재사용하며 업무 성공은 빌리지 않는다. 기존 근거 없는 성공은 stale로 보존한다.

backend 관련 17건 및 UI 두 파일 16건 통과를 확인했다. 마지막의 종료 상태 조회/이미 수집한 명령 목록 재사용 변경 뒤 관련 4건을 별도로 확인했다. 이 중 조회 사례 2건은 앞선 17건에 없는 추가 범위이므로 중복을 제외한 총 범위는 backend19 + UI16이다. backend TypeScript build와 frontend TypeScript/production build가 통과했다. 최초 제한 환경 esbuild 상위 폴더 거부와 UI 편집 중 구문 오류는 수정·재실행 결과와 구분한다. 변경 도중 source/plan stale을 거부한 두 사례의 안내 문구는 실제 변경 원인을 포함하도록 보완했고 최종 관련 검사에서 통과했다. 브라우저 시각 검증이나 로컬 전체 suite 성공으로 표현하지 않는다.

기존8193bac CI41249773899는 전체 test 단계 진행 중으로 결과가 확정되지 않았다. 새 사전 dispatch/전체 로컬 suite는 만들지 않았다. 최종 릴리스 커밋의 필수 tag CI1회에서 게이트를 그대로 적용하며 source SHA가 다른 이전 CI artifact는 재사용하지 않는다. 정식 공개와 지정 portable 업데이트는 그 검증 성공 이후 수행한다.
