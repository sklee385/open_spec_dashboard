# 프로세스 핸들 동일성 보강 Implementation Plan

> **For agentic workers:** 현재 승인된 C 사본과 이 세션에서 비례적으로 진행한다. 하위 에이전트를 만들지 않는다. 변경 없는 검사·전체 suite·운영 재시작/설치는 수행하지 않는다.

**Goal:** PID를 읽은 뒤 재사용된 다른 프로세스를 Job에 배정하거나 종료하는 경합을 막고 실제 소유 자식만 보호한다.

**Architecture:** 네이티브 가드가 먼저 프로세스 HANDLE을 열고 유지한 뒤, 실제 ChildProcess의 전용 IPC에 새 nonce를 보내 실제 pid를 응답받는다. pid/nonce가 일치하는 경우에만 호스트가 가드에 배정을 승인한다. 가드가 핸들을 유지하는 동안 해당 프로세스 객체의 ID는 다른 객체에 재사용되지 않으므로 승인 뒤에는 보유한 동일 HANDLE만 사용한다. 호스트 종료는 저장 PID 대신 가드 전용 stdin EOF로 관측한다.

**Tech Stack:** Node24 ChildProcess IPC, C#/.NET Framework, Windows Job/HANDLE, 기존 프로젝트 런타임/Vitest.

## 근거와 경계

- Microsoft는 핸들 보유 중 프로세스 객체 및 ID 수명을 설명한다: https://devblogs.microsoft.com/oldnewthing/20110107-00/?p=11803 및 https://learn.microsoft.com/en-us/windows/desktop/procthread/process-handles-and-identifiers
- stdin/IPC는 직접 생성한 자식에 연결된 통로만 사용한다. Win32_Process/Get-CimInstance 조회나 다른 경로의 열거·권한 상향을 하지 않는다. persisted PID 존재/TTL을 종료 증명으로 사용하지 않는다.
- 프로젝트 명령은 기존 대기 worker에 정상 Job READY가 도착한 뒤에만 보낸다. 브라우저 및 HEAD 고정 준비/종료 토큰은 새 HANDLE 준비 토큰과 함께 확인한다. 이전 가드는 성공으로 오인하지 않고 차단한다.
- 새 외부 세션/모델 호출·원본 D 설정·운영 앱/서비스 재시작·설치/배포를 하지 않는다. 기존 종료 witness 및 HEAD 고정 해제 조건은 유지한다.

## 작업 순서

- [x] 직접 생성한 두 시험 자식 중 공개 pid만 다른 자식을 가리키게 한 실제 회귀에서 기존 준비가 잘못 성공하는지 확인한다. 모든 정리는 생성한 ChildProcess 핸들만 사용한다.
- [x] backend/scripts/guard-worker.cjs의 신원 challenge 응답을 신뢰된 절대 preload로 연결한다. browser.service.ts·execution.service.ts·local-preparation.ts·git-runner.ts의 대기 worker에 IPC를 제공한다. 프로젝트/시나리오 메시지와 별도 프로토콜을 쓴다.
- [x] BrowserGuard.cs는 HANDLE 개방→BOUND 토큰→호스트 승인→동일 HANDLE Job 배정 순으로 바꾼다. 미승인/EOF/오류에서는 다른 프로세스를 배정하거나 종료하지 않는다. host PID 대신 소유 pipe EOF를 감시한다.
- [x] browser-job.ts가 fresh nonce·실제 IPC pid·새 가드 준비 토큰을 확인하고 실패를 유한하게 보고하도록 한다. 늦은 메시지/이전 nonce는 승인하지 않는다.
- [x] 실제 PID 오지정 거부/타 자식 보존, 정상 Job/HEAD 고정, 호스트 종료 witness와 영향 있는 실제 브라우저/후보/Git 실행만 검증한다. 결과를 근거 범위대로 기록하고 커밋한다.
- [ ] 9.2의 드라이브/용량/생성·반영·제거 결합 근거와 남은 실제 재부팅/패키지 제약을 대조한다. 확인한 범위만 체크한다.

## 남은 Git 종료 경계 보강

일반 Git 변경 경로의 PID 부재 조회와 주기적 해제를 발견했다. 실제 종료를 뜻하지 않으므로 제거한다. 워크트리 생성·결과 커밋·후보 생성/수정·정리에만 기존 HANDLE IPC+독립 Job 실행을 연결하고 자손 ActiveProcesses=0 뒤 종료 증거를 저장한다. 읽기 명령에는 Job 비용을 추가하지 않으며 Windows 중단은 소유 ChildProcess 핸들만 사용한다. 종료 증거 없는 과거 기록이나 중단된 recovery claim은 PID 부재로 해제하지 않는다. 정상 종료 응답 유실은 저장된 실제 종료 근거와 Git 상태를 함께 대조한다. 실제 호스트 중단 전 증거가 저장되지 않은 일반 Git 기록의 자동 복구는 이 변경으로 보장하지 않는다.
