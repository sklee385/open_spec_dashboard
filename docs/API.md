# 로컬 API 계약

API는 `127.0.0.1:13002/api`, 프런트엔드는 13001의 프록시를 사용한다. 외부 Origin의 요청은 거부한다. 이 앱은 로컬 단일 사용자용이며 외부 네트워크에 공개하지 않는다.

## 기존 UI 호환

`GET /sources`, `GET /config`, `PUT /config/sources`, `GET/POST /ideas`, `PUT/DELETE /ideas/:id`, `GET /changes`, `GET /changes/:id`, `GET /specs`, `GET /specs/:id`, `GET /events`를 제공한다. 설정은 JSON, 아이디어는 YAML frontmatter와 Markdown 본문을 유지한다. 아이디어 삭제는 `.idea-trash` 이동으로 복구 가능하다. 식별자의 `/`는 URL 인코딩한다. 전역 SSE는 파일 감시 이벤트를 중복 정리해 보드 갱신을 알린다.

## 업무

| API | 입력·결과 |
| --- | --- |
| `POST /work` | `sourceId`, `changeName`, `requestKey`, 선택 `ideaId`. 같은 요청·같은 변경은 기존 업무를 반환한다. 아이디어 원본은 변경의 `source-ideas`에 보존한다. |
| `GET /work/:id` | 단계·실행 상태·대화 ID·문서·질문·이벤트·검증·파일 차이를 반환한다. 저장된 프로젝트 경로와 현재 등록 경로가 다르면 거부한다. |
| `POST /work/:id/message` | `{text}`. 같은 대화에 후속 턴을 추가한다. 실행 중에는 대기열에 저장한다. |
| `POST /work/:id/action` | `{action}`: `plan`, `review`, `implement`, `complete`, `reopen`, `archive`. `complete`는 `confirmed:true`도 필요하다. |
| `GET /work/:id/document?path=...` | `path`, `content`, SHA-256 `version`. 연결된 변경 문서만 허용한다. |
| `PUT /work/:id/document` | `path`, `content`, `version`. 버전 충돌은 409와 `latest`를 반환한다. 상대 경로·실경로·심볼릭 링크 경계를 검사하고 같은 폴더 임시 파일로 교체한다. |
| `POST /work/:id/answer` | `questionId`, `answers:{질문ID:{answers:[문자열]}}`. 모든 질문에 답해야 한다. 만료 질문은 명시적 `recover:true`로 같은 대화의 후속 메시지에 복구한다. |
| `POST /work/:id/approval` | `questionId`, `decision:accept/decline`. 요구사항 질문 응답과 분리하며 요청 유형에 맞는 Codex 응답을 전송한다. |
| `POST /work/:id/interrupt` | 현재 검증 프로세스 또는 Codex 턴 중단을 요청한다. 실제 종료 이벤트 전에는 새 실행을 시작하지 않는다. |
| `PUT /work/:id/verification-plan` | `commands:[{id,command,args:[]}]`. 등록된 명령 전체를 필수 검증으로 사용한다. |
| `POST /work/:id/verify` | `{commandId}`. 출력·종료 코드·명령 정의·프로젝트 파일 해시를 기록한다. |
| `GET /work/:id/openspec` | `operation`: status/instructions/schemas/specs/spec/deltas/diff/validate/doctor/context. instructions는 artifact, spec은 artifact에 기준 명세 이름도 필요하다. 실제 CLI 종료 코드·출력·오류·가능한 JSON을 반환한다. |
| `GET /work/:id/events?after=순번` | `work-update` SSE와 증가 순번. `Last-Event-ID`로 재연결하며 해당 업무만 전송한다. heartbeat는 15초. 연결 해제는 Codex를 종료하지 않는다. |

단계와 실행 상태는 별개다. 단계는 planning/reviewed/implementation/verification/completed/archived이며 실행 상태는 idle/connecting/creating-thread/running/waiting-input/waiting-approval/interrupted/failed/recovery-required다.

문서·필수 질문·사용자 검토·최신 검증·최종 확인을 서버에서 검사한다. UI 버튼 상태만으로 실행이나 완료를 허용하지 않는다. 질문은 앱 영속 ID와 프로세스 세대별 요청 ID를 구분한다. 이미 응답했거나 다른 세대의 요청에 대한 직접 응답은 409다.

## 저장과 실행 설정

SQLite `user_version=1`, WAL, 업무의 요청 키 및 소스·변경 쌍에 UNIQUE 제약을 사용한다. 업무, 이벤트, 종류별 질문·답변·검증·초안 이력 레코드를 저장한다. 이벤트는 업무별 조회에서 전역 증가 순번을 커서로 사용한다. 저장소는 자식 프로세스와 감시자를 정리한 뒤 닫는다.

`CONFIG_PATH` 또는 `OPENSPEC_UI_CONFIG`는 설정 경로, `DATA_DIR`은 SQLite 경로, `CODEX_BIN`은 실행 파일을 지정한다. `CODEX_ARGS`는 테스트 전용이다. 명령 인자를 셸 문자열로 합치지 않는다. 파일 차이는 Git 유무와 관계없이 구현 시작 스냅샷과 현재 파일을 비교한다.

# 대기 요청 알림

`GET /api/work/attention`은 업무를 소유하는 백엔드 서버의 현재 대기 요청을 조회한다. 별도 웹 게이트웨이를 배포한 환경에서는 같은 API를 전달한다.
응답은 `{ items: [{ workId, sourceId, changeName, title, questionId, kind, status, createdAt }] }`이다.
`kind`는 `input` 또는 `approval`, `status`는 `pending`이다. 한 요청에 여러 질문이 있어도 한 건이다.
전송·복구·결과 확인 중이거나 응답·만료된 요청은 제외한다. 발생 시각 내림차순, 동률은 요청 ID·업무 ID순이다.
제목은 보존된 원본 아이디어 제목, 없으면 변경명이다. 질문 원문·명령·프로젝트 경로는 반환하지 않는다.
프로젝트 표시는 `sourceId`와 등록된 소스 정보를 연결한다. 대시보드는 최초 즉시, 이전 조회 완료 후 5초마다 조회하며 포커스·연결 복귀 시 즉시 갱신한다.

## Windows 알림 설정·상태

`GET /api/notifications/settings`, `PUT /api/notifications/settings`는 업무를 소유하는 백엔드 서버에서 처리한다. 별도 게이트웨이 배포 환경에서도 같은 계약을 사용한다. GET은 저장 의도를 변경하지 않는다.

| 필드 | 의미 |
| --- | --- |
| `enabled` | 저장된 사용 의도. 최초 true. 의도도 손상되어 읽을 수 없으면 null. |
| `effectiveEnabled` | 읽기 전용 실제 발행 준비 상태. OS 표시·소리 성공을 뜻하지 않는다. |
| `dashboardUrl` | 로컬 HTTP(S) 주소. 확인 불가 시 null. |
| `registrationStatus` | uninitialized / registered / disabled / unsupported / failed / unregistered |
| `lastError` | null 또는 settings-error / registration-error / unregister-error / storage-error / delivery-error / unsupported. 민감한 도우미 출력은 제외한다. |

PUT은 `{enabled?:boolean,dashboardUrl?:string,unregister?:true}`만 받는다. 적어도 한 필드가 필요하며 해제에는 `enabled:false`도 필요하다. 읽기 전용 필드·외부 URL·사용자 정보·쿼리·프래그먼트는 400이다. 발행·설정 처리 중 변경 요청은 400이므로 잠시 후 사용자가 다시 시도한다. 저장 실패는 5xx이며 실제 발행을 중단한다. 등록 실패는 사용 의도를 유지한 채 실제 비활성과 오류를 반환한다. 파일은 `DATA_DIR/notifications.json`에 임시 파일 후 원자 교체한다.

최초 주소는 `OPENSPEC_DASHBOARD_URL` → `http://127.0.0.1:13001/`, 이후 저장 주소 우선이다. localhost, 127.0.0.1, [::1]만 허용한다. 주소 오류는 명시적 주소 저장으로 복구하고 사용 의도까지 손상되었으면 두 필드를 함께 지정한다.

서버는 질문 복구·만료 후 즉시, 처리 완료 후 5초마다 확인한다. `(workId,questionId)` SHA-256 키의 native-notification 레코드를 INSERT OR IGNORE로 먼저 확보하고 claimed/submitted/failed/uncertain을 기록한다. 미완결 claimed는 재시작 때 uncertain으로 바꾸며 명확한 실패도 재시도하지 않는다. 저장 실패 시 OS를 호출하지 않는다. 설정·브라우저 데이터 삭제는 발행 기록을 초기화하지 않는다. IndexedDB는 화면 안내 중복 방지에만 쓴다.

고정 PowerShell 실행 파일·인자와 stdin JSON, XML 이스케이프, 로컬 microsoft-edge: 링크를 사용한다. 토스트에는 업무명·요청 종류와 기본 알림음 한 번만 넣는다. 링크는 workId와 questionId를 함께 포함하며 앱 최초 복원 전에 검증한다. 링크 처리는 조회·화면 이동만 수행하고 생성·재연결·답변·승인·검토·구현 API는 호출하지 않는다.

## 업무 복구 진단 (v0.1.3)

GET `/api/work/:id`는 `recovery: {required,canReconnect,code,mode}`를 추가한다. mode는 shared 또는 isolated다. 기존 공유 폴더 업무의 legacy-workspace와 정상 격리 업무의 isolated-workspace는 같은 대화로 복구한다. workspace-unavailable·project-unavailable은 실제 폴더 복원이 필요하고, thread-unknown은 기존 대화 ID 확인이 필요하다. thread-in-use는 다른 Codex의 점유 해제 후 재시도한다. busy·completed는 재연결할 수 없다. session-restarted·connection-failed도 재시도할 수 있다.

기존 POST `/api/work/:id/reconnect`를 그대로 사용한다. 요청마다 현재 상태·경로·식별 정보를 다시 검사한다. 성공은 동일 work/thread ID와 원래 업무 단계로 반환하며 thread-reconnected 이벤트에 mode/code를 기록한다. 실제 연결을 시도하다 실패하면 recovery-failed 이벤트에 원인을 기록한다. 복구는 새 대화나 AI 턴을 시작하지 않는다. 오류는 409와 message/errorCode로 반환한다. 완료·보관·진행 중 업무 및 활성 질문·승인은 재연결을 차단한다.

격리 경로가 손상돼도 업무 조회는 진단과 기존 이벤트를 반환하며 문서·검증 명령을 비워 제공하고 이전 검증은 fresh:false로 표시한다. 문서 직접 조회·구현·반영은 계속 식별 검증을 적용하며 원본 프로젝트를 대체 경로로 사용하지 않는다. 화면의 검토 가능 버전은 비활성화하되 저장된 검토 기록은 변경하지 않는다.

복구 성공 시 연결이 끊기기 전에 queued로 남은 지시는 blocked로 보존한다. 복구 이벤트가 대기열 자동 실행을 유발하지 않도록 같은 저장 트랜잭션에서 처리한다. 사용자는 문서·실행 기록을 확인한 뒤 필요한 지시만 다시 보낸다. 기존 pending 질문·승인은 복구 요청을 차단하며, 만료된 질문의 복구 기능은 유지한다.
