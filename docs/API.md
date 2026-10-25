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
