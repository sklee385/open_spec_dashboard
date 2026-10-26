# 구현 및 검증 기록

검증일: 2026-10-25. 사용자 검토 후 구현 시작 지시에 따라 실행했다. 아래 결과는 사용자 결과 검토·완료 확인을 대신하지 않는다.

## 구현 범위

- `backend/src/review/`: Markdown 구문 트리의 명시적 목록 표기 추출, 문서 해시·원문 범위·버전 기반 식별자, 공통 조회 서비스 및 생성 AI 지침.
- 변경/업무의 `review-items` 추가 API: 허용 문서만 조회하고 누락·권한 오류를 부분 오류로 제공한다. 조회는 reviewedVersion·업무 단계를 변경하지 않는다.
- DetailModal·WorkRoom: 공통 검토 목록, 문서 그룹·종류·로딩·빈 목록·오류·재시도, 최신 버전 확인 후 원문 위치 이동.
- WorkRoom: 저장·폐기·취소로 초안 보호, 저장 성공 후 재조회. 문서 이동과 주기 조회가 겹칠 때 이전 응답을 무시한다.
- 기존 보드 SSE와 검토 목록이 파일 변경 연결을 공유한다. 갱신 요청의 응답 순서가 뒤바뀌어도 최신 요청만 반영한다.
- 공개 사용법과 실제 추출 예제: `docs/document-review.md`. 이전 문서 자동 표기 및 항목별 승인 상태는 추가하지 않았다.

## 자동 검증

프로젝트 전용 런타임으로 실행했다.

| 명령 | 결과 |
| --- | --- |
| `./scripts/npm.ps1 run test:run --workspace frontend -- src/components/ReviewNavigation.test.tsx src/components/ReviewItems.test.tsx src/hooks/useSSE.test.ts src/components/WorkRoom.test.tsx src/components/WorkRoomRecovery.test.tsx` | 5개 파일, 41개 테스트 통과 |
| `./scripts/npm.ps1 run test:run --workspace backend -- test/review-api.test.ts test/review-items.test.ts` | 2개 파일, 7개 테스트 통과 |
| `./scripts/npm.ps1 run build --workspace backend` | 통과 |
| `./scripts/node.ps1 node_modules/@fission-ai/openspec/bin/openspec.js validate add-document-review-tab --strict` | 통과 |

추출·API·목록 표시·원문 이동 테스트를 구현 전에 실행해 기능 부재에 따른 실패를 확인한 뒤 통과시켰다. 공개 예제, 네 종류·여러 줄·중첩 목록, 코드·주석 제외, 업무 격리, 경로 이탈, 누락·권한 실패, 추가·수정·삭제, 미저장 초안, 저장 후 갱신, 버전 변경 및 이전 응답 무시를 검증했다.

읽기 전용 코드 검토에서 발견한 두 응답 경합은 재현 테스트를 추가해 수정했다. 다른 변경으로 전환한 뒤 도착한 이전 상세 응답과 겹친 원문 이동을 방어한다. 기존 WorkRoom 승인 테스트의 기대 문구는 현재 UI의 `이 요청 승인`에 맞췄다.

추가 검토에서 원문 요청 대기 중 문서 탭의 선택기로 이동을 겹칠 수 있는 경로도 확인했다. 이동 중 선택기를 비활성화하고 이동 진입 가드 및 진행 중 작업 수를 적용했다. 해당 재현 테스트의 실패와 수정 후 프런트엔드 41개 테스트 통과를 확인했다.

## 초기 전체 통합 검증의 제한

`./scripts/npm.ps1 test`와 `./scripts/npm.ps1 run build`를 실행했으나 공유 작업 공간의 다른 진행 중 변경으로 전체 통과하지 못했다.

- 전체 테스트: 백엔드 11개 파일·66개 테스트 통과. 프런트엔드는 99개 통과·2개 실패와 2개 테스트 파일의 모듈 누락. 누락 모듈은 `MarkdownDocument`, `MermaidBlock`이며, 2개 실패는 변경된 파일 차이 화면과 기존 다국어 계약 테스트 사이의 불일치였다.
- 전체 빌드: `ApprovalRequest.tsx`의 번역 함수 인자 타입 오류 2건과 위 두 모듈의 누락으로 실패했다. 이 변경의 타입 오류는 정리했지만 전체 빌드 성공을 주장하지 않는다.
- 다른 변경의 제품 코드·미완성 기능을 임의로 구현하거나 되돌리지 않았다. 해당 작업 반영 후 전체 테스트·빌드를 다시 실행해야 한다.

## 초기 Microsoft Edge 확인

사용자가 설치한 ChatGPT 확장으로 Edge에 연결했다. 별도 browser MCP 서버는 사용하지 않았다.

- 기존 실행 화면에서 WorkRoom의 사용자 검토 탭·로딩·표기 안내를 확인했다.
- 이후 Edge 연결 명령이 두 차례 시간 초과됐다. 새 탭에서는 앱 오류 화면의 `Sparkles is not defined`를 확인했다.
- 따라서 **두 화면의 검토 목록·원문 이동·오류 복구 브라우저 검증은 미완료**다. 자동 테스트 통과를 브라우저 검증 통과로 대체하지 않았다.
- 실행 중 Codex 업무를 보존하기 위해 13003 세션 서버를 재시작하지 않았다.

## 재개 시 사용자 결정과 보완

사용자는 `integration_scope` 질문에서 **이 오류까지 함께 수정**을 선택했다. 당시 전체 검증을 막던 ApprovalRequest 번역 타입 오류와 MarkdownDocument·MermaidBlock 누락을 보완했다. 원문 HTML/위험 URL을 실행하지 않고, GFM·이미지 실패·Mermaid 크기 제한·SVG 정제·비동기 결과 격리·확대/축소를 기존 테스트로 검증했다. SVG 내부 CSS 제거 후에도 도형·텍스트·선이 보이도록 안전한 표현 속성을 보완했다. 다른 OpenSpec 변경의 완료·보관 상태는 처리하지 않았다.

통합 확인에서 추가로 보완한 사항:

- WorkRoom의 **변경 문서 보기** 버튼으로 DetailModal에 접근할 수 있다.
- 업무 화면보다 상세 모달과 배경막을 앞에 표시한다.
- 카드 정보가 오래돼도 최신 문서 내용으로 탭을 구성한다.
- 실행 중 서버의 상세 응답에 버전 필드가 없어도 원문 SHA-256을 계산해 검토 항목 버전과 비교한다. 13003 세션 서버를 재시작하지 않는다.
- 배경 목록 갱신은 클릭을 끊지 않으며 실제 원문 이동 중에는 중복 선택을 막는다. 오래된 목록 응답은 화면에 적용하지 않고, 원문 이동 결과는 해당 문서 버전과 다시 대조한다.
- 테스트 동시성을 1로 제한했다. OS 메모리 부족 시 `NODE_OPTIONS=--max-old-space-size=512 --max-semi-space-size=2`를 해당 검증 프로세스에만 적용했다.

## 재개 후 Microsoft Edge 실검증

사용자 설치 ChatGPT 확장을 통한 Microsoft Edge에서 확인했다. 개발 서버 자동 갱신이 검증 화면을 초기화하여, 최신 Vite 빌드를 별도 검증 포트 `13011`에서 열어 최종 확인했다. Vite 번들 생성만으로 타입 검증 통과를 대신하지 않았으며 전체 빌드는 별도 실행했다.

- 검증용 소스 `session-demo`에 `review-integration`, `review-tab-check` 샘플을 만들었다. 실제 사용자 계획 문서에는 표기를 소급 삽입하지 않았다.
- WorkRoom과 DetailModal 모두 문서별 항목·종류·여러 줄 설명을 표시했다.
- 두 화면에서 누락된 `design.md · ENOENT`와 재시도 버튼을 확인하고 재시도했다. 누락 문서를 복구한 뒤 SSE로 오류가 사라지고 설계 항목이 추가되는 것을 확인했다.
- 연결 오류 시 이전 목록을 오래된 내용으로 표시하고 원문 버튼을 막는 것을 확인했다. 검증용 서버 연결 복구 후 목록과 선택 기능이 회복됐다.
- DetailModal에서 설계 탭으로 이동하고 **3행의 `[review:decision] 복구 후 설계 항목`**이 강조되는 것을 화면과 DOM 위치로 확인했다.
- WorkRoom에서 같은 설계 원문으로 이동한 뒤 에디터가 포커스를 가지며 `- [review:decision] 복구 후 설계 항목`이 실제 선택된 것을 DOM으로 확인했다.
- 조회 후 샘플 업무의 `reviewedVersion: null`, `phase: planning`, `state: idle`을 API로 확인했다. 검토 완료·구현 시작·사용자 완료 액션은 실행하지 않았다.

## 초기 보류 당시 후속 확인

다른 진행 중 변경의 화면·빌드 오류가 정리되면 전체 명령을 재실행하고 Edge에서 두 화면의 목록·원문 이동·오류 복구를 확인한다. 그 뒤 사용자에게 결과 검토를 받는다. 현재 업무 완료·보관 처리는 하지 않았다.

## 최종 결과

위 초기 보류 사항은 재검증으로 해소했다. 공유 작업 공간에 진행 중인 다른 변경이 추가되는 동안 생겼던 중간 실패는 최신 결과와 구분한다.

| 최종 검증 | 결과 |
| --- | --- |
| `./scripts/npm.ps1 test` | 프런트엔드 28개 파일·149개 테스트, 백엔드 15개 파일·86개 테스트, 총 **235개 통과**, 종료 코드 0 |
| `./scripts/npm.ps1 run build` | 프런트엔드 타입 검사·Vite 번들·백엔드 TypeScript 빌드 통과, 종료 코드 0 |
| OpenSpec strict 검증 | 통과 |
| 변경 파일 `git diff --check` | 공백 오류 없음 |
| Microsoft Edge 사용자 설치 ChatGPT 확장 | 두 화면의 목록·원문 위치 이동·부분 오류·재시도·SSE 및 연결 복구 확인 |

최종 전체 테스트 및 빌드에는 검증 프로세스에만 `NODE_OPTIONS=--max-old-space-size=512 --max-semi-space-size=2`를 적용했다. 시스템 설정이나 다른 실행 업무의 메모리 옵션은 변경하지 않았다. 빌드에는 500kB 초과 번들 안내가 남아 있으며 빌드 실패는 아니다.

검증용 13011 미리보기 서버는 해당 포트를 직접 시작한 프로젝트 Node 프로세스인지 확인한 뒤 종료했다. 기존 13001·13002·13003 서버는 종료하지 않았다. 검증 샘플의 누락 문서는 복구된 상태로 남겼다.

구현·검증 체크리스트는 7/7이다. **사용자 결과 검토·업무 완료 확인·보관은 실행하지 않았다.**
# 커밋 전 재검증 (2026-10-25)

- 요청한 `proposal.md` SHA-256 `6fb02c3f743d6975d48f304beebf6d8eb87a859dfc101e0294007f221b2dead8`와 현재 문서가 일치한다.
- 전체 작업공간: 프로젝트 런타임으로 `npm test` 235개(프런트 149, 백엔드 86) 통과, `npm run build` 통과.
- 다른 진행 중 변경을 제외한 Git 인덱스를 `.tools/review-commit-tree`로 추출해 별도 검증: 테스트 175개(프런트 107, 백엔드 68) 및 전체 빌드 통과. 설치된 의존성은 원래 작업공간의 `node_modules`를 참조했다.
- `git diff --cached --check` 통과. 번들 500 kB 초과 안내는 경고이며 빌드 실패는 없다.
- 현재 대화가 `running`인 동안 완료 API는 거절한다. 대화 종료 후 기존 API를 통한 검토 버전 확인, 필수 검증 실행, `complete` 처리 결과는 `.tools/review-finalize-status.json`에 기록한다. 상태 파일의 `completed` 확인 전에는 앱 완료로 간주하지 않는다.
