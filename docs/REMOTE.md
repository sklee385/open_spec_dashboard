# 모바일 Codex에서 Board 원격 제어

PC의 Board를 실행한 뒤 업무 화면의 원격 연결 정보에서 **Node 실행 파일**, **CLI 파일**, **연결 파일** 경로를 확인한다. 모바일 Codex가 공식 원격 기능을 통해 이 PC에서 명령을 실행할 수 있는 환경이 필요하다. 실제 모바일 연결 가능 여부는 아직 검증하지 않았다.

CLI는 Board API를 인터넷에 공개하지 않고 별도의 `127.0.0.1` 포트에 연결한다. 연결 파일은 인증 정보를 포함하므로 내용을 대화에 붙여 넣거나 출력하지 않는다. `--connection`에는 파일의 절대 경로만 지정한다. 데스크톱 인증 토큰을 전달할 필요가 없다.

```powershell
& '<표시된 Node 경로>' '<표시된 CLI 경로>' --connection '<표시된 연결 파일 경로>' list
& '<Node 경로>' '<CLI 경로>' --connection '<연결 파일 경로>' status <업무ID>
```

변경 명령은 사용자가 생성한 UUID를 `--request-id`에 지정한다. `message`, `answer`, `approval`, `interrupt`, `reconnect`, `recover-session`, `cancel-session-recovery`을 지원한다. 메시지는 `--text` 또는 body JSON을 `--stdin`으로 전달한다. 셸 인용 문제와 명령행에 메시지가 남는 것을 피하려면 `--stdin`을 권장한다.

```powershell
'{"text":"현재 작업 상태를 확인해 주세요"}' | & '<Node 경로>' '<CLI 경로>' --connection '<연결 파일 경로>' message <업무ID> --request-id <UUID> --stdin
& '<Node 경로>' '<CLI 경로>' --connection '<연결 파일 경로>' command-status <동일한UUID>
```

질문과 승인은 `status`의 현재 `questions`에서 `status: pending`인 요청을 확인한 뒤 정확한 `questionId`와 `generation`을 보낸다. 질문 답변 body는 `{"questionId":"표시된ID","generation":"표시된generation","answers":{"질문ID":{"answers":["사용자답변"]}}}`이며, 승인 body는 `{"questionId":"표시된ID","generation":"표시된generation","decision":"accept 또는 decline"}`이다. 과거 질문 복구, 만료된 요청, 다른 세션 요청의 승인은 원격 도구가 처리하지 않는다.

변경 요청의 응답은 실행 완료가 아닌 접수 확인이다. `command-status`에서 `accepted`, `running`, `completed`, `failed`, `uncertain`을 확인한다. `completed`는 해당 API 호출의 완료이며 전체 AI 작업의 종료를 뜻하지 않는다. 실제 업무 결과와 중단 완료 여부는 `status`로 확인한다.

연결이 끊기거나 시간 초과가 발생하면 **같은 UUID로 상태를 먼저 조회**한다. 같은 UUID와 같은 내용은 재실행하지 않으며, 내용이 다르면 거절한다. Board 재시작 당시 처리 중이었던 명령은 `uncertain`으로 보존하고 자동 재실행하지 않는다. 명령이 없다는 응답을 확인한 경우에만 원래 UUID와 내용을 그대로 재전송한다. 해당 업무의 원격 API 호출이 진행 중이면 새로운 변경 명령을 거절한다. 기존 Board의 실행·검토·승인·작업 폴더 제한도 그대로 적용한다.

원격 연결 정보 API는 `GET /api/remote`이며 기존 Board 인증을 거친다. 비밀값 없이 경로, `available`, `transport: loopback`, `mobileVerified: false`를 제공한다. 명령 기록이 손상되면 원격 연결만 비활성화하고 Board는 계속 시작한다. 기록을 임의 삭제해서 명령을 다시 실행하지 않는다.

연결 파일과 명령 기록은 DATA_DIR 내부에 생성되며 POSIX 모드 0600(디렉터리 0700)을 요청한다. Windows에서는 POSIX 모드가 사용자별 ACL을 대체하지 않으므로 DATA_DIR에 적용된 계정 접근 권한이 보안 경계다. 다른 계정과 DATA_DIR을 공유하지 않는다.

미확인 복구를 명시적으로 중단하려면 `cancel-session-recovery`에 body JSON `{"requestId":"원래 복구 UUID"}`를 전달한다. CLI `--request-id`는 이번 중단 명령의 별도 UUID이며 body의 원래 복구 ID와 구분한다. 중단은 기존 세션·실행 상태를 검증한 뒤 처리하며, 완료 상태와 업무 상태를 다시 조회한다.
