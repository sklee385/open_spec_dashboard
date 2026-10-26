# 서버가 반복 종료된 원인과 수정

## 원인

Codex 명령의 부모 PowerShell은 Windows Job에 포함된다. 실제 제한 플래그는 `0x2800`으로 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`와 `JOB_OBJECT_LIMIT_BREAKAWAY_OK`가 설정되어 있었다.

기존 `scripts/start.ps1`은 `Start-Process`로 숨김 PowerShell을 생성했다. 새 창이나 백그라운드 실행만으로는 부모 Job에서 분리되지 않는다. 명령 실행 Job이 정리되면 그 안의 PowerShell·Node 서버도 종료되므로, 시작 직후 HTTP 200을 확인해도 이후 다시 연결이 끊길 수 있었다. 당시 서버 오류 로그에는 애플리케이션 예외나 메모리 오류가 남지 않았다.

## 수정

첫 수정의 `CREATE_BREAKAWAY_FROM_JOB`은 테스트용 하위 Job에서는 분리되었지만 전체 Job 조회에서는 연결이 남았다. 첫 검증 범위가 충분하지 않았고 세션 서버가 다시 종료되었다.

최종 수정은 `scripts/start-detached.ps1`에서 Windows 프로세스 관리 서비스의 `Win32_Process.Create`를 통해 `scripts/run-independent.ps1`을 실행한다. 이 경로는 Codex 명령의 프로세스 트리와 모든 Job에서 분리된다. 실행 창은 숨기며 프로젝트 PATH·작업 폴더·표준 출력과 오류 로그는 유지한다. 시작 결과의 PID와 종료 시각·종료 코드를 별도 JSON에 기록한다.

지원되는 설정 경로·데이터 경로·Codex 실행 파일·포트 등의 호출자 환경은 현재 사용자 DPAPI로 암호화해서 전달한다. 인증 값은 시작 기록에 평문으로 저장하지 않는다. PID 결과 파일은 임시 파일에서 원자적으로 교체해 쓰기 도중 읽히는 문제를 막는다.

서비스를 통한 실행이 거부되면 실패를 알리고 명령 자식으로 실행하는 대체 경로는 사용하지 않는다. 일반 PowerShell에서 `./scripts/start.ps1`을 실행하면 된다. Node/npm은 프로젝트 전용 런타임을 계속 사용한다. 관리자 권한이나 시스템 설정 변경, 예약 작업 등록은 필요하지 않다.

프로세스 분리는 자동 재시작 감시가 아니다. 세션 서버를 임의 재실행하거나 대기 중인 질문·승인을 만료시키는 동작을 추가하지 않았다. 실행 중인 포트는 시작 스크립트가 유지한다.

## 검증

- 기존 Start-Process 방식이 부모 테스트 Job을 상속하는 문제를 재현했다.
- 같은 테스트 Job에서 새 방식은 자식이 테스트 Job뿐 아니라 **어떤 상위 Job에도 포함되지 않음**을 확인했다.
- 공백이 있는 경로와 stdout·stderr 로그 전달을 확인했다.
- 일반 실행 환경에서 `$env:RUN_SERVER_LAUNCH_TESTS='1'; ./scripts/npm.ps1 run test:run --workspace backend -- test/server-launch.test.ts test/gateway.test.ts`: 5건 통과. 실제 WMI 프로세스 생성 권한이 필요한 통합 테스트이므로 명시적으로 활성화한다.
- 실제 세 서버를 새 방식으로 시작하고, 시작 명령 종료 후 별도 명령에서 같은 프로세스 생존과 HTTP 200 응답을 확인했다.
- 실제 서버를 소유하는 PowerShell PID 505092·501440·497840의 전체 Job 조회에서 `inJob:false`를 확인했다. 이전 검증처럼 테스트 하위 Job만 확인하지 않는다. PowerShell이 직접 실행한 Node 자식은 서비스 PowerShell이 관리하는 Job에 포함될 수 있으므로, Node의 Job 포함 여부만으로 Codex 명령 Job 상속이라고 판단하지 않는다.
