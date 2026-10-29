# 구현·검증 기록

## 2026-10-27 폴더 선택 재검증과 그룹 1 완료

- 사용자가 실수로 종료했다며 재진행을 지시했다. 기존 임시 Electron 런타임과 동일한 sandbox:true fixture를 재실행했고 자동 종료 시간을 15분으로 늘려 승인·선택 시간을 확보했다.
- 컴퓨터 도구로 `Workspace Picker Fixture` 창(ID 6498210)을 관찰하고 실제 `폴더 선택` 버튼을 클릭하여 Windows 폴더 선택 대화상자까지 확인했다. 이 네이티브 대화상자 검증은 Codex 내장 브라우저의 제품 화면 검증(9.5)을 대신하지 않는다.
- 후속 Escape 입력은 `Computer Use was not approved to use electron`으로 거부됐다. 도구가 취소·선택을 자동 수행했다고 주장하지 않는다. 사용자가 직접 선택한 실제 대화상자 반환 결과가 `.tools/workspace-picker-result.json`에 10:58:53 기록됐다: `canceled:false`, `filePaths:["D:\\open_spec_board_work"]`. Node/PowerShell 호스트에서 해당 디렉터리 존재도 확인했다.
- 실제 native picker → 고정 IPC 반환 경로는 현재 호스트의 절대 경로다. 취소/지원 불가 시 수동 입력과 반환 경로 표시·초안 유지 등은 기존 frontend/desktop 자동 테스트로 함께 검증했다. 해당 경로를 작업 공간 설정으로 저장하거나 신규 공간을 만들지는 않았다.
- 그룹 1 회귀를 새로 실행했다: backend 8개 파일 32개, frontend 5개 파일 43개, desktop 3개 파일 21개 테스트 통과. 합계 96개다. 1.6을 완료 처리하여 7/54가 됐고 기존 순서에 따라 그룹 2를 시작한다. 9.5는 여전히 미완료다.

## 2026-10-27 재개 후 검증 환경 준비

- 사용자 “검토 완료 다시 구현 시작해라” 지시에 따라 재개했다. 변경 문서와 기존 구현은 지정된 C: 격리 공간에 있고, D: 원본에는 `workspace-settings.service.ts`가 아직 없음을 확인했다. 원본 코드 반영 없이 기존 격리 공간을 유지한다.
- C:·D: 작업 경로 안의 설치 Electron은 모두 AppContainer ACL 오류로 실제 테스트 창을 시작하지 못했다. ACL을 변경하거나 샌드박스를 해제하지 않았다.
- 설치된 D: Electron 런타임을 별도 신규 임시 폴더 `C:\Users\NOVELPIA\AppData\Local\Temp\openspecboard-picker-verification-5b724db114624d398f373b5a95a8b9bd\electron`에 복사했다. 복사·실행 도구 요청은 허용됐으며 새 폴더의 기본 상속 권한을 사용하고 sandbox:true를 유지했다. 운영 앱·DB·13003 세션을 조작하지 않았다.
- 숨김 테스트 실행을 종료한 뒤 대화형 테스트 창을 표시했다. stdout의 `Workspace Picker Fixture ready`와 컴퓨터 도구 inventory의 `Workspace Picker Fixture` 창(ID 66061788)으로 기동을 확인했다. 로그에 GPU 영속 캐시 파일 열기 오류가 있으므로 로그 전체 무오류로 보고하지 않는다.
- 실제 폴더 선택을 위해 해당 창에 접근했으나 컴퓨터 사용 도구가 `Computer Use app approval timed out`을 반환했다. 클릭·입력·폴더 선택은 수행하지 못했다. 이는 셸 도구의 자동 승인 심사 거절과는 다른 창 제어 승인 시간 초과다. 승인 없이 다른 입력 방식으로 우회하지 않았다.
- fixture의 자동 종료 후 소유 테스트 프로세스 세션 두 개 모두 exit 0을 확인했다. exit 0과 창 기동을 폴더 선택 검증 통과로 취급하지 않는다. 1.6은 미완료, 진행률은 6/54이며 후속 그룹 구현은 진행하지 않았다.
- 실행 근거: `.tools/workspace-picker-runtime.json`, `.tools/workspace-picker-smoke.stdout.log`, `.tools/workspace-picker-smoke.stderr.log`. 실제 폴더 선택은 테스트 창 제어 승인 후 재시도해야 한다. 이번 재개에서는 제품 코드 변경이나 새 제품 테스트 통과를 주장하지 않는다.

## 2026-10-27 초기 설정

- 사용자가 최신 계획 검토 완료와 별도 구현 시작을 명시적으로 지시했다. 현재 진행률은 tasks.md 기준 6/54이며 1.6은 실제 검증 차단으로 미완료다. 그룹 2~9는 아직 구현하지 않았다.
- 지정 작업 경로는 Git 메타데이터 없는 외부 관리 복사 공간이다. 원본 저장소의 커밋 ID·미커밋 diff는 여기서 확인할 수 없다. 커밋·stash·reset·원본 반영·보관을 하지 않았다.
- 구현: 기존 config의 `workspaces` 키와 profile/root/version, 설정 원자 저장과 프로세스 간 SQLite 잠금, 경로·실부모 식별·보호 영역·링크 검사, 고유 probe, 관리 하위 공간 소유 등록, 검사/저장 API, 설정 UI와 한국어/영어, 폴더 선택 IPC와 패키징 목록, 독립 시작 스크립트의 WORKSPACE_ROOT 전달.
- 저장 잠금 DB `<configPath>.lock.sqlite`에는 설정값을 저장하지 않는다. 비정상 종료한 실제 자식 프로세스의 OS 잠금이 해제되어 다른 자식에서 후속 저장이 가능한 것을 확인했다.
- 새 Git 워크트리 기본값은 활성화하지 않았다. 공통 공간·용량 제한·생성·통합·정리 연결 전이므로 초기 설정 저장만으로 FileResults의 기존 생성 경로를 전환하지 않는다. 실제 전용 폴더를 대신 확정하지 않았다.

### 수행한 검증

실행은 프로젝트 전용 Node/npm을 사용했다. 기존 설정 로더의 esbuild 상위 경로 접근 오류와 외부 TEMP 쓰기 제한 때문에 Vitest의 runner 로더와 작업 공간 내 임시 경로를 사용했다. 프런트 Vite 설정은 ESM에서 동작하도록 `__dirname`을 `fileURLToPath(new URL('./src', import.meta.url))`로 교체했다.

```powershell
# backend 디렉터리에서
$env:TEMP = (Resolve-Path ../.tools/test-temp).Path
$env:TMP = $env:TEMP
../scripts/node.ps1 ../node_modules/vitest/vitest.mjs run --configLoader=runner test/workspace-settings.test.ts test/workspace-paths.test.ts test/workspace-root.test.ts test/workspace-settings-api.test.ts test/workspace-settings-process.test.ts test/legacy-api.test.ts test/files.test.ts test/ai-tools.test.ts

# frontend 디렉터리에서
$env:TEMP = (Resolve-Path ../.tools/test-temp).Path
$env:TMP = $env:TEMP
../scripts/node.ps1 ../node_modules/vitest/vitest.mjs run --configLoader=runner --maxWorkers=1 src/components/WorkspaceSettings.test.tsx src/components/AiToolSettings.test.tsx src/i18n/i18n.test.tsx src/i18n/contracts.test.tsx src/i18n/screens.test.tsx
../scripts/node.ps1 ../node_modules/typescript/bin/tsc -b
../scripts/node.ps1 ../node_modules/vite/bin/vite.js build --configLoader=runner

# 프로젝트 루트에서
./scripts/node.ps1 --test desktop/test/workspace-picker.test.cjs desktop/test/dashboard-preload.test.cjs desktop/test/security.test.cjs
./scripts/npm.ps1 run build --workspace backend
```

- 프런트: 5개 파일, 43개 테스트 통과. 설정 검사/확인 전 저장 차단, 편집 시 토큰 무효화, 버전 충돌 후 초안 유지, 최신 설정 조회, 환경 고정과 번역, 폴더 선택 취소·호스트 선택 경로 반영을 확인했다.
- 백엔드: 최종 집중 회귀 8개 파일, 32개 테스트 통과. 설정 보존·충돌·경로 경계·소유권·검사 토큰·실제 프로세스 간 재조회/비정상 종료 복구와 기존 API를 확인했다.
- 데스크톱: 3개 파일, 21개 테스트 통과. picker 취소와 신뢰 프레임·종료 제한, preload의 고정 IPC, 기존 앱 보안·수명 회귀를 확인했다. 실제 Windows 폴더 다이얼로그 검증과는 별개다.
- backend 빌드, frontend 타입 검사·프로덕션 번들 빌드 통과. 프런트 번들에 500 kB 초과 청크 경고가 있으며 오류는 아니다.
- `openspec validate add-git-worktree-workspaces --strict` 통과. apply 상태는 ready, 6/54 완료로 확인했다. 이 결과는 실제 폴더 선택 검증이나 전체 구현 완료를 뜻하지 않는다.
- 테스트를 먼저 실패시킨 뒤 저장·경계·소유·API·UI 동작을 구현했다. 코드 검토에서 환경 경로 정규화, 관리 폴더 유실/identity 교체 가용 판정, 종료 후 저장 잠금 해제 문제를 재현하고 수정했다. 별도 재검토에서 새 Critical/Important 회귀는 발견되지 않았다.

### 차단·미수행

- 1.6 실제 폴더 선택: 격리 fixture `.tools/workspace-picker-smoke.cjs`를 Electron으로 실행했으나 설치 디렉터리의 AppContainer ACL 때문에 Electron이 시작 전 FATAL 종료했다. ACL 변경이나 `--no-sandbox`로 우회하지 않았다. 실패한 테스트 프로세스는 종료됐고 운영 OpenSpecBoard 창·서비스는 조작하지 않았다.
- Windows 독립 실행 심화 회귀: `RUN_SERVER_LAUNCH_TESTS=1`로 server-launch 테스트를 실행했으나 `Invoke-CimMethod Win32_Process.Create` 접근 거부로 차단됐다. 서비스 설정 자체의 환경 우선순위·재실행 유지·무재시작 재조회는 별도 실제 Node 자식 프로세스 테스트로 확인했다. CIM의 실제 환경 전달 성공으로 보고하지 않는다.
- Codex 내장 브라우저: 컴퓨터 도구 inventory에 Edge 확장만 있고 내장 브라우저가 없어 화면 검증을 수행하지 않았다. Edge 확장은 사용자 지시에 따라 사용하지 않았다. 9.5는 미완료다.
- 전체 backend/frontend 전체 회귀와 그룹 9 결합 검증, 설치·무설치 패키지 검증은 아직 수행하지 않았다. 이 기록을 9.4나 사용자 최종 검토 완료로 처리하지 않는다.
- 실행 중 13003 세션 서버를 재시작하지 않았으며 새 코드가 운영 서버에 반영됐다는 근거는 없다.

### 코드 식별

제품 변경 파일 16개의 SHA-256 목록을 `.tools/workspace-settings-implementation-hashes.json`에 기록했다. 목록 파일의 SHA-256은 `4f70a8e601c2627d18d43c6d60a201b60a9913c03f64b26ebcc24596a34b5c47`이다. Git 커밋 버전을 대신한 현재 복사 공간의 스냅샷 식별이며 운영 배포 버전이 아니다.

### 복구 지시 처리와 공통 공간 모델·경로 연결 (2026-10-27)

- 사용자 직접 선택 결과 `.tools/workspace-picker-result.json`의 `canceled:false`, `filePaths:["D:\\open_spec_board_work"]`를 채택했다. 기존 초기 설정 회귀 96개·그룹 1 완료 7/54 기록을 보존하며 재선택·테스트 창 제어 재승인을 요청하지 않는다. 대화상자 반환 검증과 운영 설정 저장은 별개이며 실제 설정은 대신 저장하지 않았다.
- 2.1: copy/git-worktree 공통 모델과 profile/root/workspace 식별·고정 경로를 저장하고 소유 검증 resolver를 추가했다. 기존 공유/격리 baseline과 threadId는 변환하지 않는다. Git 등록 검증 연결 전에는 Git 종류를 복사로 대신하지 않고 거부한다. 모델 테스트 5개와 backend 빌드가 통과했다.
- 2.2: FileResults와 WorkRecovery의 경로 판정을 WorkspaceService로 통합했다. 공간 메타데이터가 있는데 executionPath가 사라진 경우 공유 원본으로 재연결되던 동작을 실패 테스트로 재현한 뒤 차단했다. 기존 복사 반영·완료·같은 대화 재연결 회귀를 유지한다.
- 검증: backend에서 프로젝트 Node로 `vitest run --configLoader=runner --maxWorkers=1 test/isolated-workflow.test.ts test/codex-work.test.ts test/workspace-service.test.ts test/work-files.test.ts` 실행, 4개 파일 51개 통과. backend build 통과. apply 9/54를 확인한다.
- 첫 결합 회귀는 임시 executionPath 길이 325자인 상태에서 Windows 자식 spawn이 ENOENT/ENOTCONN으로 실패했다. 동일 경로를 사용하는 독립 spawn으로 재현했다. 제품 경로·실행 코드를 바꾸지 않고 TEMP/TMP를 허용 작업 루트 D:\sklee\2.work\phpstorm\0.etc_work\open_spec_dashboard\.tools\wt로 지정한 뒤 동일 회귀가 통과했다. 실패를 숨기거나 테스트 판정을 완화하지 않았다.
- 운영 앱·13003 서버를 재시작하지 않았고 원본 코드 반영·완료·보관을 수행하지 않았다.

### 루트 이력·참조 보호 (2.3)

- GET /api/workspace-settings/roots에 과거 루트와 업무·후보 참조를 제공하고 DELETE /api/workspace-settings/roots/:rootId는 현재 선택/환경 고정/참조 존재/오래된 버전을 거부한다. 등록 해제는 설정 목록만 변경하며 디스크 파일을 제거하지 않는다. 저장 기록의 rootId와 고정 실행 경로를 검사해 기존 복사 공간·후보 참조도 보호한다.
- WorkspaceService.reserve는 현재 확인된 루트에서 준비 의도의 고정 식별·경로를 저장한다. 파일 생성·복사·Git 생성 자체는 그룹 3에서 연결하며 아직 신규 기본값으로 활성화하지 않는다. 루트 설정 잠금 안에서 예약을 저장해 전환/등록 해제와 교차하지 않게 한다.
- 실제 임시 루트 A/B에서 A 질문 대기·threadId·경로 보존, B의 새 루트 준비 예약, 참조/후보/환경 고정/버전 충돌 차단, 참조 없는 과거 루트 해제 후 파일 보존을 확인했다. 설정/모델 집중 회귀 4개 파일 19개와 backend build 통과. 잠금 보강 후 루트 이력 2개를 다시 통과했다.

### 용량 집계 (2.4)와 정책 연결 진행 (2.5)

- 용량 집계는 전체/루트/업무/통합 후보/공유/기타와 잔여·측정 시각을 제공한다. 의존성·빌드·중단·미등록 잔여 파일을 포함하며 심볼릭 링크·junction은 추적하지 않는다. dev/ino로 공유 경로·hardlink 중복을 제외한다. 100,000항목 또는 250ms 집계 예산을 넘기거나 읽기/잔여 확인에 실패하면 부분/미확인 상태로 남긴다. 삭제 동작은 없다.
- 용량 fixture 3개와 backend build 통과. 코드 검토에서 후보 폴더 분류를 설계의 projects/<projectId>/integrations/<candidateId>에 맞췄고 fixture를 다시 통과했다.
- 별도 검토가 발견한 WORKSPACE_ROOT 후행 구분자의 과거 루트 해제 우회는 실패 요청 테스트로 재현 후 resolve 정규화로 수정했다. 정책 API 포함 backend 7개 파일 44개, 설정 UI/i18n 3개 파일 30개와 frontend 타입 검사 통과. 2.5는 추가 실행 진입·UI 검증을 진행 중이며 아직 완료 처리하지 않는다.

### 그룹 2 검증·정책 및 준비 실패 차단 (2.5·2.6)

- 설정 정책 API/UI에 동시 활성 구현·검증 업무 3개, 최소 잔여 5 GiB, 자료 보존 제안 14일을 연결했다. 저장값·정수 검사·버전 충돌·초안 보존을 확인했다. 계획 대화는 구현/검증 한도를 소비하지 않는다. 준비 중·연결 중·실행·질문/승인·검증을 세고 중단 공간은 용량에만 포함한다. 한도 축소는 기존 실행을 종료하지 않으며 다음 요청에 대기 오류를 반환한다.
- Codex/외부 CLI/명령/브라우저 및 구현 시작에서 활성 한도를 검사한다. 구현 연결 전에 요청 단계를 먼저 저장하여 연결 await 중에도 슬롯이 예약된다. 두 실제 send 호출과 대기 client fixture로 한도 1 경쟁을 재현해 차단했다. 후보는 저장소당 1개인 별도 guard를 제공하며 실제 후보 생성은 그룹 5에서 연결한다. 기간 경과는 정리 제안만 생성하고 자동 삭제하지 않는다.
- 생성/복사/설치/빌드 stage guard는 전후 잔여를 확인하고 미확인·부족·작업 실패를 영속 기록한다. 실제 FileResults의 생성·복사·무결성·identity/baseline 저장 전체를 감싸 실패 잔여를 보존한다. 실패 기록이 있으면 경로 사용과 새 UUID 복사 재시도를 차단하여 AI 실행으로 넘어가지 않는다. 후속 로컬 설치/빌드 구현은 같은 sync/async stage guard를 사용한다.
- 기존 work-files의 ‘복사 실패 후 새 경로 재시도’ 기대는 승인 설계의 잔여 확인 전 자동 새 경로 재시도 금지에 맞춰 실패 기록/복구 차단 검증으로 바꿨다. 준비 완료된 기존 복사 업무의 반영·완료·대화 복구 회귀는 유지한다.
- 검증: backend 그룹 2 및 기존 업무/설정/coordinator 11개 파일 90개 통과. 브라우저 한도 진입 테스트 1개 통과(해당 파일 기존 6개는 이 실행에서 제외). 연결 슬롯 경쟁 보강 후 root-history/policy/codex-work/isolated-workflow 4개 파일 35개 통과. frontend 설정/i18n 5개 파일 45개, 타입 검사와 Vite 빌드 통과. backend build 및 strict OpenSpec 검증 통과. 기존 500 kB 초과 번들 경고는 유지된다.
- 검토 지적의 환경 경로 정규화, 후보 integrations 분류, 준비 전체 실패 기록, 브라우저 한도, 계획 단계 제외, 연결 중 슬롯 예약을 수정하고 해당 회귀를 추가했다. 최종 코드 검토 결과는 이어서 기록한다.
- 초기 설정 96개·폴더 선택 성공·7/54개 당시 기록을 보존한다. 이번 선택을 운영 설정 저장으로 취급하지 않고 운영 앱/13003 재시작·원본 반영·완료·보관은 수행하지 않았다. Codex 내장 브라우저 9.5는 미수행 상태를 유지한다.

### 그룹 2 최종 재검토 및 Git 사전 점검 (3.1)

- 최종 독립 재검토에서 Critical/Important 잔여 문제는 발견되지 않았다. 검토자가 정책/준비/루트 이력 3개 파일 14개를 재실행해 통과했다.
- WorktreeManager.inspect는 기존 Git runner의 인자 배열·환경 제거·시간/출력 제한을 사용하여 실제 root/common-dir/HEAD/로컬 브랜치/변경 목록을 읽는다. detached는 명시적 로컬 브랜치 선택을 요구한다. 비Git·초기 HEAD 없음만 copy 가능 상태로 구분하고 설치/권한/Git 오류·경계 불일치·submodule은 copy로 전환하지 않는다.
- 실제 Git fixture 4개 테스트와 backend build 통과. staged/unstaged/untracked와 원본 HEAD/index 불변, detached 선택, unborn, Git 실행 실패, 하위 폴더와 submodule 경계 거부를 확인했다.
- 비Git fixture가 원본 D 저장소 아래 있으면 상위 저장소의 dubious ownership 오류가 발생함을 확인했다. 전역 safe.directory를 바꾸지 않고 이 상태를 Git 오류로 유지했다. 실제 비Git fixture는 Git 메타데이터 없는 C 격리 테스트 경로에 만들었다.

### Git 생성 의도·고유 공간·실제 상태 복구 (3.2)

- WorktreeManager.create는 고정 루트/공간 예약과 요청 키·기준을 DB transaction에 기록한 뒤 고유 codex/work-<workId> 브랜치와 exclusive 컨테이너 identity를 생성한다. 동일 요청은 저장된 의도/실제 등록을 재조회하고 내용·키 불일치는 거부한다. 동시에 들어온 같은 요청은 동일 생성을 공유한다. 기존 브랜치/공간을 덮어쓰거나 실패를 copy로 바꾸지 않는다.
- root/profile/업무 식별, 일반 .git 포인터, common-dir, worktree 등록, HEAD/브랜치 및 생성 전후 원본 HEAD·선택 브랜치 tip을 대조한다. Git 성공 후 응답 유실은 실제 소유 등록과 변경 없는 기준을 확인해서만 복구한다. 생성 전 장애는 잔여/대화/고정 경로를 보존하며 새 경로를 만들지 않는다. 문서/런타임 준비 전이므로 공간은 preparing 상태이며 아직 AI 시작이나 신규 기본값으로 활성화하지 않는다.
- checkout hook이 새 공간 제품 파일을 자동 변경하는 것을 실제 fixture로 재현하고 worktree add에 컨테이너의 빈 hooks 경로를 지정했다. 브랜치 tip 이동, 동시 중복, 실제 생성/재조회, 응답 유실, 생성 전 장애, identity 변조와 hook 회귀를 검증했다.
- 실제 Git 2개 파일 12개 테스트, backend build 및 strict OpenSpec 통과. 최종 독립 읽기 검토에서 Critical/Important 잔여가 발견되지 않았다(검토자는 이번 Git 테스트를 재실행하지 않았다).
- 작업 루트/일반 사용자 TEMP의 고정 관리 경로에서 Git 자체가 '$GIT_DIR too big'을 반환함을 직접 비교했다. Git의 명시적 GIT_DIR 길이 검사 근거: https://github.com/git/git/blob/master/setup.c (repo_discover_explicit_gitdir). 전역 Git/ACL/설계 경로는 바꾸지 않고 짧은 C:\Users\Public\Temp의 고유 g-* 테스트 저장소에서 회귀를 수행했다. 임시 저장소 이외 원본/운영/선택한 D:\open_spec_board_work는 변경하지 않았다. 긴 운영 루트에서 같은 오류가 나면 실패 기록을 보존하고 짧은 루트를 안내해야 하며 자동 경로 변경은 하지 않는다.

### 검토 문서 manifest·제외 확인·독립 복사 (3.3)

- workspace-documents는 해당 변경의 proposal/design/tasks/.openspec.yaml, specs 및 source-ideas Markdown만 수집한다. 원문 hash/크기 manifest와 tasks 체크만 정규화한 계획 revision을 따로 저장한다. 링크/hardlink/경계 이탈/크기 초과/읽기 중 변경을 거부하고 API에는 본문·비밀값을 넣지 않는다.
- 미커밋 제품 코드·다른 업무 문서·환경 파일을 제외 목록에 제시하고 필요한 코드가 기준에 없으면 별도 보존·정리 후 기준 재확인을 안내한다. preview 토큰을 문서·제외 목록·검토 버전·브랜치/HEAD/기준 커밋·제거할 문서 목록에 결합했다. 확인하지 않았거나 목록/기준/문서가 바뀌면 복사를 시작하지 않는다.
- 새 Git 공간의 검토 대상 문서만 독립 복사하고 원본·index·미커밋 제품 코드는 유지한다. 해당 공간의 오래된 allowlist 문서만 제거해 manifest를 맞춘다. 복사 전후 원본 HEAD·선택 tip·manifest/목록을 재검사해 중간 변경은 잔여를 보존한 recovery-required로 남기며 AI 준비 완료로 진행하지 않는다.
- 단위 및 실제 Git 2개 파일 9개 통과, backend build/strict OpenSpec 통과. Windows fixture의 CRLF 차이는 fixture-local core.autocrlf=false로 고정했고 운영 Git 설정은 바꾸지 않았다. 검토자가 발견한 다른 브랜치 preview 토큰 재사용을 실제 Git으로 먼저 재현한 뒤 수정했다. 최종 읽기 재검토에서 Critical/Important 잔여는 발견되지 않았다(재검토자는 테스트를 재실행하지 않았다).

### 문서 전용 기준 커밋과 검토 revision (3.4)

- commitDocuments는 가져온 문서·원본 기준·검토 버전을 다시 확인하고 explicit 문서 경로만 stage한다. 제품 변경/이동과 문서 외 index를 거부한다. 원본이 아닌 업무 브랜치에만 문서 커밋을 만들고 고정 actor·빈 hooks 경로·비대화식 서명 설정을 사용한다.
- 실제 commit의 parent=baseCommit, 변경 경로, provenance marker, 전체 허용 문서 집합과 Git blob의 정규화 planRevision을 검증한다. baseCommit/workspaceBaselineCommit/sourcePlanRevision/reviewedVersion을 보존한다. 제품 diff의 기준은 문서 커밋이며 최종 통합 기준은 원래 baseCommit이다. tasks 체크/CRLF 차이와 계획 내용 변경을 구분한다.
- commit intent를 먼저 저장하며 응답 유실은 실제 커밋을 확인해 중복 커밋 없이 복구한다. 복구 때도 제품·문서·index 상태를 검사하고 바뀌었으면 잔여/HEAD/index를 보존한 채 차단한다. skip-worktree로 삭제 누락을 숨기는 실제 index 변조를 재현해 전체 ls-tree/manifest 집합 대조로 보강했다.
- 3.1~3.4 결합 Git 회귀 4개 파일 24개 통과 후 검토 지적에 대한 정상/복구/dirty/index/숨긴 삭제 누락 4개를 추가·재검증해 통과했다(그 실행의 다른 7개는 제외). backend build와 strict OpenSpec 통과. 최종 독립 읽기 재검토에서 Critical/Important 잔여는 발견되지 않았다.
- 사용자 선택 경로의 운영 저장·운영 앱/13003 재시작·원본 반영·완료·보관·신규 Git 기본값 활성화는 하지 않았다. 그룹 3의 로컬 준비/실행 연결은 계속 진행한다.

### 로컬 준비 allowlist·독립 런타임·준비 명령 (3.5)

- 프로젝트/계획 revision에 결합한 확인 목록과 버전·명령을 저장한다. 검토한 환경 파일·런타임·의존성만 독립 복사하고 운영 DB/로그/다른 업무/원본 제품 코드의 우회 수입을 거부한다. secret 본문과 명령 출력을 응답·준비 결과에 넣지 않으며 문서 기준 이후 별도 로컬 자료로 유지해 커밋하지 않는다.
- 설치/빌드는 업무 cwd, exclusive runtime-data 및 임시 HOME/TEMP/npm cache에서 실행한다. 운영 인증값·DB·설정을 전달하지 않는다. 복사 전후 원문 hash/소유와 결과의 writable junction/hardlink를 검사하며 사설 데이터 identity도 재검사한다. 실패는 잔여를 보존하고 실행 경로를 차단한다. 같은 준비 재조회는 자료 변조를 확인하고 명령을 자동 반복하지 않는다.
- 독립 검토에서 부모 명령 정상 종료 후 후손 서버가 남는 문제를 실제 재현했다. 대기 worker를 기존 Windows Job Object 가드에 먼저 등록한 뒤 명령을 시작하고 가드 종료 확인 뒤에만 passed로 기록하도록 수정했다. 가드 미준비는 프로젝트 명령 시작 전 차단하고 uncertain 기록을 보존한다. 회귀에서 남았던 테스트 후손 1개는 고유 fixture PID와 실행 파일 경로를 대조해 종료했으며 운영 프로세스는 건드리지 않았다.
- 검증: 로컬 준비 10개(실제 독립 Node·후손 종료·가드 미준비·junction·사설 데이터 hardlink·변조 포함), 실제 Git 문서/기준/로컬 준비 14개 통과. backend build 및 strict OpenSpec 통과. 가드는 D:의 기존 BrowserGuard.exe를 읽기 전용 테스트 런타임 경로로 지정했으며 운영 앱/13003은 재시작하지 않았다. 최종 준비 ready/신규 분기/API는 다음 3.6에서 연결한다. 신규 기본값은 활성화하지 않았다.

### 신규 Git/비Git 분기·기존 copy 유지·생성/복구 API (3.6)

- WorkspaceProvisioner와 업무 소유 확인을 거치는 workspace status/preview/prepare/recover API를 연결했다. 실제 Git만 Git 공간을 만들고 비Git/초기 HEAD 없음은 사유와 명시 확인 후 고정 copy 공간을 준비한다. Git 실패는 copy로 바꾸지 않는다. 기존 copy는 설정 루트와 실험 허용 여부에 관계없이 원래 경로·baseline·대화 ID를 유지한다. 생성 성공은 AI 시작·원본 반영·완료·보관과 별도다.
- Git 등록을 동기 확인하는 제한된 읽기 경로를 공통 공간 서비스에 연결했다. Promise를 동기 검증 콜백에 넘기지 않는다. 매 경로 사용에서 실제 common-dir·등록·HEAD/브랜치와 .git 포인터/역참조의 소유 경계를 확인한다. 생성기와 동기 조회가 같은 포인터 검사를 공유한다. Git 업무를 기존 파일 복사 반영으로 처리하는 요청은 명시 거부한다.
- 생성 응답 유실은 같은 요청·고정 공간의 실제 상태로 복구한다. 토큰 만료 후 해당 공간에서 preview를 다시 발급할 수 있으나 문서/제외 목록·검토·Git 기준·정책은 기존 의도와 같아야 한다. 새 경로/브랜치/대화나 실패 로컬 명령을 자동 반복하지 않는다. 신규 기본값은 비활성이고 격리 개발 검증에서만 OPENSPEC_WORKTREE_EXPERIMENTAL=1을 명시했다. 실험 경로를 허용하면 새 업무가 예전 copy 진입으로 이를 우회할 수 없다.
- 독립 리뷰 지적의 만료 토큰 재확인 누락, 다른 worktree 포인터 치환, 신규 copy 인증 폴더 복사/baseline 유입을 각각 합성 fixture로 실패 재현 후 수정했다. .aws/.codex/.reference 및 운영 DB/로그/로컬 비밀 파일을 신규 copy와 snapshot 양쪽에서 제외한다. 실제 사용자 인증 파일은 읽지 않았다. 최종 읽기 재검토에서 Critical/Important 잔여는 발견되지 않았다.
- 검증: 신규 분기/등록/응답 유실·6분 토큰 만료 복구/보호 자료 6개와 격리 HTTP API 1개 통과. 기존 공간/파일 결과/복사 완료/준비 실패 회귀 4개 파일 32개 통과. backend build 및 strict OpenSpec 통과. API·사용 절차를 docs/API.md와 docs/PROJECT-WORKSPACE.md에 기록했다. 그룹 3 결합 회귀는 이어서 기록한다. 초기 96개·7/54 기록과 사용자 선택 경로 반환 검증은 보존하며 운영 설정·원본·운영 앱/13003에는 반영하지 않았다.
- 그룹 3 최종 결합 회귀: 실제 Git 사전 점검/생성/문서 기준/로컬 준비/신규 분기와 격리 API 7개 파일 46개 통과(162.86초). 3.6까지 19/54개 완료를 apply 결과로 확인했다. 이 선행 검증 후 그룹 4를 시작한다.

### AI 계획 쓰기 범위·고정 실행 공간·외부 CLI (4.1)

- 공통 AI context는 기존 공간의 식별을 검증하며 계획 cwd와 sandbox writableRoots를 해당 변경 폴더 하나로 제한한다. cwd도 암묵적 쓰기 루트이므로 원본 프로젝트를 계획 cwd로 두지 않는다. 구현/검증은 저장된 업무 공간을 사용한다. 변경 이름 이탈과 변경 내부의 symlink/hardlink를 차단하고 공간 경로가 유실돼도 원본으로 대체하지 않는다.
- Codex의 같은 threadId·resume/rollout 복구·ask_user 및 기존 질문/승인 통로를 유지한다. 업무 경로·변경 경로·제품 참조/쓰기 범위와 별도 반영 경계를 실행 지시에 명시한다. 설치된 Codex의 app-server JSON schema를 .tools/codex-protocol-schema에 생성하여 turn/start sandboxPolicy/writableRoots 계약을 확인했다. 실제 모델 턴의 OS 쓰기 차단을 실행 검증한 것은 아니며 대화 fixture에서 전송 계약을 검증했다.
- 외부 CLI는 계획 폴더만의 쓰기 제한을 보장하지 못하므로 spawn/업무 상태 변경 전에 409와 차단 사유를 반환한다. 기존 외부 CLI 회귀는 검토·준비된 구현 공간에서 입력/진단/중단/인자 안전성을 검증하도록 조정했으며 계획 차단을 별도 검증한다. 운영 도구 설정이나 기존 업무 연결을 변경하지 않았다.
- 검증: AI context/같은 대화·질문/기존 copy workflow/외부 CLI/도구 5개 파일 41개 통과, backend build/strict OpenSpec 통과. 독립 리뷰에서 내부 문서 hardlink 우회를 같은 합성 fixture로 재현했으며 수정 후 읽기 재검토에서 Critical/Important 잔여는 발견되지 않았다. 검토자 재실행은 긴 TEMP의 기존 ENOTCONN으로 isolated-workflow 1개가 실패했고 다른 28개는 통과했다. 주 실행은 앞서 검증한 짧은 D: .tools/wt TEMP에서 해당 파일을 포함한 41개가 통과한 결과다. 이 제한을 숨기거나 실제 모델/브라우저 검증 성공으로 보고하지 않는다.

### 실행·OpenSpec·소스 조회와 업무별 Git 결과 (4.2)

- ExecutionService의 스냅샷/명령 조회와 업무 OpenSpec API·문서 저장·ProjectResolver를 검증된 공통 공간 경로에 연결했다. executionPath 필드만 사라져도 workspace/baseline 기록이 있으면 원본으로 대신 조회하거나 실행하지 않는다. 완료·보관 기록의 기존 저장 자료 조회는 유지한다.
- Git 결과는 문서 workspaceBaselineCommit 대비 해당 공간의 tracked/untracked 변경만 비교한다. 원본 미커밋·다른 업무·준비 때 가져온 문서를 새 제품 변경으로 포함하지 않는다. 로컬 준비 파일·비밀값·운영 자료를 제외하고 파일 내용·mode·index/HEAD 상태의 수집 전후를 대조한다. legacy snapshot/revision 형식은 mode 필드가 없을 때 보존한다.
- 리뷰에서 mode-only 변경 누락과 MM 상태를 유지한 수집 중 mode 변경을 실제 Git으로 재현해 비교·revision·최종 raw 검사에 mode를 포함했다. 실제 실행 검증이 mode 변경 뒤 stale이 되는지 확인했다. 공유 symlink/junction/hardlink·미병합 index·준비 후 추가된 gitlink/중첩 Git 경계는 정상 빈 diff로 숨기지 않고 확인 불가로 차단한다.
- 신규 관리 공간의 로컬 준비 제외 정책을 ProjectFiles/ProjectGit 응답에도 적용했다. 합성 .env 직접 GET과 hardlink 별칭 GET/diff·copy 업무 결과 유입을 실패 재현 후 수정했다. 신규 managed copy/Git만 엄격 소유를 적용하며 파일 열기 전·후 nlink/identity를 확인한다. 기존 원본/legacy copy의 정책은 유지한다. 실제 사용자 비밀 파일은 읽지 않았다. 최종 독립 읽기 재검토에서 Critical/Important 잔여는 발견되지 않았다.
- 검증: 실제 A/B Git 기준 diff·cwd·루트 변경·mode stale/수집 경합·로컬 목록/별칭·gitlink·공간 유실 및 OpenSpec HTTP cwd/경로 유실의 최종 2개 파일 8개 통과. 신규 생성/복구와 Git/API 결합 3개 파일 13개도 앞선 별칭 보강 후 통과했다(이후 gitlink 회귀 1개를 추가). 기존 project API/files·명령·copy 완료/파일 결과·엄격 source fixture 6개 파일 56개 통과, 소유권 보강 후 project-files/work-files/strict-source 3개 파일 38개 통과. backend build 및 strict OpenSpec 통과. API 문서를 갱신했다. 다음은 4.3 잠금 세분화이며 운영·13003 재시작/원본 반영/완료/보관은 하지 않았다.

## 2026-10-27 4.3 범위별 잠금 — 22/54

- 문서(변경별), 실제 공간/index·HEAD, 공유 관리, 원본 통합의 자원을 원자적으로 취득하고 통합→관리→정렬 공간→ref 순서의 역순 중첩을 거부한다. 대기 중 다른 잠금을 잡고 기다리지 않는다.
- 실제 A/B Git fixture에서 A 질문은 A 공간만 차단하고 B 쓰기/index는 허용한다. 같은 공간·실제 ref는 직렬화하며 management/integration은 공통 관리 자원에서 충돌한다. 준비 프로세스 종료 미확인과 범위가 저장된 uncertain은 영향 공간/ref를 차단한다. 범위 없는 과거 기록은 보수적인 공통 경계를 보존한다.
- 리뷰 재현으로 비Git 기존 상위 잠금과 신규 하위 문서 잠금의 단방향 우회, symbolic-ref 별칭 충돌 누락을 수정했다. 명시 refs도 최대 16단 해석하고 현재 HEAD를 항상 합쳐 저장 당시의 최종 ref를 사용한다. 한글·점 브랜치 허용, 무관한 저장소의 손상된 HEAD가 전역 차단이 되지 않는 회귀를 추가했다. 손상된 HEAD는 해당 공간과 같은 common-dir의 미확인 ref만 보수적으로 차단한다.
- 검증: 짧은 D: TEMP/TMP에서 operation-locks/project-coordinator/workspace-policy 3파일 30개 통과(13:50 실행), backend build 및 OpenSpec strict 통과. 마지막 읽기 리뷰에서 Critical/Important 잔여 없음. 기존 초기96/7단계 기록 보존.
- 이 단계는 coordinator 경계 구현이며 기존 호출부 전환은 4.4에서 수행한다. 운영 앱·13003 재시작, D: 원본 반영, 선택 폴더 재선택/설정 저장은 수행하지 않았다.

## 2026-10-27 4.4 호출부별 범위 적용 — 23/54

- ProjectController의 파일 변경을 변경 문서별/실행 공간별로 분류하고 Git stage/commit은 index, ref 관리·fetch·pull·push는 관리, 브랜치 전환·원본 반영·보관은 통합으로 연결했다. AI/검증 진입은 같은 coordinator의 범위·영속 기록을 검사한다. 문서 저장·OpenSpec 변경 생성·아이디어 이동/수정과 공간 준비도 공통 경계를 사용한다. 운영 앱이나 13003에 반영하지 않았다.
- 새 Git API intent는 첫 저장부터 scope/commonDir/확정 refs/affectedRoots를 보존한다. 과거 범위 없는 기록은 보수적인 common-dir 보호를 유지한다. Alpha 문서 uncertain이 독립 Beta 문서까지 차단하던 호출부의 중복 workspace 검사를 제거하고 실제 controller 회귀를 추가했다. pull의 내부 fetch도 공유 원격 추적 ref를 바꾸므로 management+기존 ref를 함께 잠근다.
- worktree 추가의 관리 잠금은 실제 생성 stage에서만 잡고 설치·빌드 전 해제한다. 준비 중 고정 공간과 원본 해당 변경 문서는 계속 점유한다. 실제 prepareLocal 진입 시 관리 잠금 자유/같은 준비 공간 index 거부/원본 해당 문서 거부를 확인했다.
- 생성·문서 stage/commit은 실행 전 DB workspace-git-intent를 저장하고 기본 runner의 PID, 범위, 종료 미확인을 보존한다. failed/recovery-required가 되어도 running/uncertain의 영향 범위는 유지된다. 실제 등록·기준 커밋 검증 뒤에만 해제하며 running/종료 미확인은 PID 부재까지 확인한다. PID가 없으면 종료를 추정하지 않는다. 응답 유실은 동일 고정 공간 실제 상태로 복구하며 명령을 자동 반복하지 않는다.
- Git 업무의 .openspec.yaml/source-ideas를 조회/검토 대상으로 포함하고 전체 계획 revision을 기존 검토 hash에 결합했다. 초기 reviewedVersion과 문서 기준은 다시 쓰지 않고 추가 문서 변경 시 구현 gate를 막는다. tasks 진행 체크/CRLF만의 변화는 전체 계획 revision에서 보존한다.
- 검증: scoped-calls/project-api/operation-locks/reviewed-plan 4파일 34개 통과. 최종 scoped-calls/project-coordinator/operation-locks/project-git/workflow 5파일 85개 통과(258.88초). 생성·문서·복구 최종 3파일 25개 통과(147.41초), 앞선 생성/결과/manager 3파일17개 통과. backend build 및 strict 통과, 최종 읽기 리뷰 Critical/Important 잔여 없음.
- 브라우저 서비스 회귀의 최초 4실패 중 1건은 독립 업무 fixture가 같은 executionPath를 복제한 문제라 수정했다. 나머지 런타임 경로 누락 3건을 구분했고, 경로 보완 후 샌드박스의 종료 확인 2실패는 권한이 허용된 고유 fixture 실행에서 7개 모두 통과했다. Codex 내장 브라우저 사용자 동선(9.5)을 수행한 것으로 보고하지 않는다.
- 다음은 4.5의 AI tool owner 검증 점유 전달이다. 폴더 재선택·운영 설정 저장·원본 반영·사용자 완료·보관은 수행하지 않았다.

## 2026-10-27 4.5 진행 중 — CLI 쓰기 중지 증거 결정 대기

- 현재 owner/turn에 묶인 일회용 검증 context와 별도 공간 lease를 구현 중이다. provider request/generation·동일 thread/turn·추가 writing item, 사용자 idle 검증과 AI 도구 검증을 구분했다. turn/start 응답 전 관찰한 writing item이 등록 때 유실되는 회귀는 실패 재현 후 generation/work/turn별 추적으로 수정했다.
- 프로토콜 context/handoff와 실제 tool-owner runner·기존 CLI 화면 증거 전달의 4파일18개는 통과했다. 앞선 기존 Codex 업무 회귀 포함 실행에서는 stale fixture가 browserScenario를 덮어쓰는 1건, provider context 없는 CLI fixture 1건을 발견해 수정했다. backend build도 통과했다. 이 결과는 악성 CLI/래퍼의 실제 쓰기 중지 증거를 검증한 것이 아니다.
- 독립 읽기 리뷰가 합성 수정 CLI를 실제 child로 실행해 `{contextCurrentWhileWriting:true,productChangedDuringVerification:true}`를 재현했다. 따라서 현재 문자열/cwd 기반 CLI paused 판정은 충분하지 않으며 4.5를 완료하지 않는다. 최종 승인·기본 활성화·운영 반영은 수행하지 않았다.
- 설계의 CLI 호환과 검증 중 쓰기 금지를 동시에 유지하려면 신뢰 중계/실행 확인 보강 또는 해당 turn 중단 후 검증 방식의 결정이 필요하다. 결정 항목은 design/tasks의 review:decision에 기록했다. 기존 23/54, 초기 선택 결과와 96개/7단계 이력, C: 구현 경로 및 대화 ID를 보존한다.


## 2026-10-29 이 채팅에서 복구·병합 검증 완료

- 사용자 재개 지시에 따라 사라진 이전 Temp 공간의 기준 스냅샷과 native 변경 기록에서 완료 4.4까지의 소스를 복구했다. 원본 DB와 대화 파일은 읽기 전용으로 사용했고 과거 shell 명령을 실행하지 않았다.
- 현재 v0.1.14 기반의 분리 Git 작업 공간에 완료 23개 변경분을 3-way 병합했다. 최신 CLI 신뢰 중계 승인 문서는 보존했으나 4.5의 실패한 시제품 제품 코드는 가져오지 않았다. 위 2026-10-27 시제품 기록은 역사적 근거다.
- per-work Codex 연결·세션 복구 및 취소·빈 세션 영속화·remote 도구·화면 복구·강제 종료·초안·트레이 기능을 유지했다. 실제 설치 Codex와 별도 CODEX_HOME의 합성 대화로 새 세션 준비 후 서비스 재생성·동일 ID 재연결·중복 방지를 확인했다. 자동 모델 턴은 실행하지 않았다.
- 검토 중 실제 active/unknown 업무가 실행 한도에서 빠지는 문제와 generatedPaths로 기존 제품 소스를 숨길 수 있는 문제를 실패 재현 후 수정했다. 과거 flag가 없는 unknown 및 inactive 외부 점유를 구분한다.
- 관련 backend 핵심 145개·정책 최종 9개·외부 CLI/브라우저 22개, frontend 설정 43개·desktop bridge 39개가 통과했다. 실제 Git 회귀는 87개 통과 후 잘못된 비Git fixture 한 건을 수정하여 해당 파일 4개 검사를 재통과했다. 전체 테스트를 수행한 것으로 보고하지 않는다.
- 이식 후 담당 에이전트와 별도로 주요 정책·설정·잠금·실제 Git 경계 8파일 50개를 재검증했다. backend/frontend build, OpenSpec strict와 diff 검사도 통과했다. Codex 내장 브라우저의 전체 사용자 동선(9.5)은 수행하지 않았다.
- 완료율은 23/54이며 4.5는 미완료다. 공개 native API에 writer pause/resume/quiescence가 없고 기존 BrowserGuard도 쓰기 중지 확인을 제공하지 않으므로, 문자열/cwd 확인이나 비공개 OS freeze만으로 완료 처리하지 않는다.
- 현재 사용자에게 별도 검증 사본·원본 변경 시 결과 무효화 방식으로의 설계 변경과 기존 쓰기 중지 요구 유지 중 선택을 요청했다. 답변 전 새 방식을 구현하거나 기존 승인을 바꾸지 않는다. 기존 Q1~Q6·폴더 선택·검토 완료 질문은 다시 묻지 않는다.
- 원본 프로젝트·원래 Board 작업의 경로/DB/단계·운영 앱·13003 서버는 변경하지 않았다. 이 브랜치의 복구 개발을 원본 반영·배포·사용자 완료 확인으로 취급하지 않는다. 워크트리 기본 활성화는 여전히 실험 설정 뒤에 있으며 결합 검증 전 켜지 않는다.

## 2026-10-29: 4.5 검증 사본 실행 완료

- 사용자 명시 선택 “검증 사본 방식으로 변경하고 개발 진행 (권장)”을 근거로 기존 쓰기 중지/점유 양도 설계를 대체했다. 같은 대화·턴과 CLI run/status/cancel을 유지하며 원본 쓰기 정지를 주장하지 않는다.
- 호스트 전용 사본을 원본/다른 업무 쓰기 범위 밖에 독점 생성하고 파일·빈 디렉터리·모드를 독립 복사한다. 링크·공유 하드링크·경로 겹침·실제 호스트 설정 경로·복사 중 변경은 차단한다. 데이터와 인증/CLI 통로는 복사하지 않는다.
- 파일 복사/식별은 비동기 1MiB 청크이며 취소 신호와 크기·개수·시간 예산을 검사한다. 슬롯은 첫 await 전에 예약한다. 준비/종료 후 해시 검사 중 취소를 지원하고, 종료 불명은 blocked 및 사본 보존으로 남긴다.
- 원본/사본·시나리오·대화/연결 세대 변경을 stale로 처리한다. 정상적인 검증 이후 턴 종료는 결과를 무효화하지 않는다. 완료/반영의 비동기 확인 중 업무·원시 소스·계획·질문 변경을 다시 검사하고 오래된 poll 해시를 재사용하지 않는다.
- 별도 명세 리뷰의 P1 두 건(종료 해시 중 취소, poll 이전 해시의 완료 게이트 재사용)과 품질 리뷰의 P1/P2 두 건(실제 설정 경로, 빈 폴더 누락)을 RED→GREEN 회귀로 수정했다. 재검토에서 추가 확정 P1/P2 없음.
- 구현자 관련 회귀 106개와 실제 Windows 브라우저/CLI/Job 정리 묶음을 확인했다. 최종 품질 수정 후 루트가 직접 수행한 명령: OPENSPEC_BROWSER_DIRECTORY를 기존 D: 브라우저 런타임으로 지정하고 scripts/npm.ps1 run test:run --workspace backend -- verification-snapshot browser-snapshot-service browser-verification-action-race browser-service browser-mailbox. 결과 6파일 50개 통과, 20.23초, exit 0. 이어 backend build, OpenSpec strict, git diff --check 성공.
- 최초 루트 샌드박스 검사는 esbuild 상위 경로 접근 거부로 시작하지 못했다. 권한/ACL 변경 없이 자동 검토된 정상 실행으로 재검증했으며 이를 제품 실패나 통과로 계산하지 않았다. D: 런타임은 읽기 전용 재사용하고 원본 코드/DB/운영 프로세스는 변경하지 않았다.
- 현재 제한: 원본 밖 DATA_DIR, 링크 의존성 차단, 파일512MiB/전체4GiB/10만항목/단계120초 예산. 산출물·캐시와 tasks 체크 진행도 현재 원시 변경으로 보수적 stale 처리한다. 그룹7.3/7.4에서 검토된 산출물·빌드 출처 및 의미상 최신성을 연결해야 한다. OS 악성 코드 샌드박스 보장이 아니다. 신규 워크트리 기본값은 여전히 비활성이고 전체 54개 완료·운영 반영·배포를 의미하지 않는다.

## 2026-10-29: 4.6 소스/Git 공간 표시와 겹침 경고 완료

- GET /api/projects/:sourceId/workspace에서 서버가 확인한 original/copy/git-worktree 종류·실행 경로·기준 커밋·브랜치·겹침·부분 확인·측정 시각을 반환한다. 기존 sourceId/workId 관계와 실제 공간 소유 검사를 유지한다.
- 같은 원본의 다른 활성 업무 baseline 이후 변경(커밋 포함) 및 원본 미커밋 경로의 교집합을 표시한다. 소스 본문은 응답하지 않고, 확인 불가와 비Git 원본 등은 partial로 구분한다. 겹침을 병합 성공 판정으로 쓰지 않는다.
- 기존 초안/공간 전환 보호를 유지하고 Git 업무에는 결과 커밋→후보 검증→명시적 확정 안내를 제공한다. copy 업무 안내와 구분한다.
- 리뷰에서 발견한 polling 성능 문제를 보강했다. FileResults.report의 전체 동기 소스 수집을 제거하고 Git은 비동기 name-only/untracked, copy는 SQLite 경로/해시 투영과 비동기 파일 비교를 사용한다. 겹침 수집은 1,000항목·8MiB·3초 공유 예산과 명령 출력 제한을 가지며 큰 파일/링크/변경/한도 초과는 partial로 반환한다. 기존 소유/등록 검사와 Git 상태 조회의 별도 처리 시간은 이 예산과 구분한다.
- 명세 및 품질 리뷰에서 최종 추가 P1/P2 없음. 루트 직접 재검증: TEMP/TMP=C:/Windows/Temp, scripts/npm.ps1 run test:run --workspace backend -- project-workspace-metadata project-api workspaces-api project-coordinator workspace-service worktree-create → 6파일55개 통과(56.41초). frontend의 ProjectWorkspace SourceManagementApp → 2파일39개 통과(6.02초). 양쪽 build와 diff 검사 통과. frontend build의 기존 큰 번들 경고는 남는다.
- 기본 임시 경로에서 executionPath223자일 때 신규/기존 Git 생성 모두 '$GIT_DIR too big'로 실패했다. 짧은 실행별 OS 임시 경로에서 기존 worktree-create8개도 통과했다. 전역 설정·ACL·실제 선택 폴더·원본 저장소는 변경하지 않았다. 별도 읽기 전용 조사에서 설치 Git2.54.0.windows.1의 checkout child explicit GIT_DIR 하드가드를 확인했으며, 예약 전에 이 오류를 검출하여 새 업무가 영구 경로에 고정되지 않도록 후속 회귀 보강한다.
- Codex 내장 브라우저의 실제 화면 검증은 아직 9.5 미완료다. 운영 앱/13003 재시작·원본 반영·활성화·배포는 수행하지 않았다.

## 2026-10-29: 예약 전 설치 Git 경로 하드가드 보강

- 실제 Git2.54.0.windows.1에서 ASCII 실행 경로214/215자 worktree add 성공,216/223자 실패를 확인했다. checkout child에 전달된 explicit GIT_DIR의 내부 하드가드이며 core.longpaths나 ACL 문제가 아니다. source: https://raw.githubusercontent.com/git-for-windows/git/v2.54.0.windows.1/setup.c 및 builtin/worktree.c. 숫자 길이 상수로 제품을 제한하지 않는다.
- git-path-preflight.ts가 예정 executionPath/.git를 explicit --git-dir로 읽기 전용 점검한다. 확인된 하드가드 오류는 경로 미지원으로, 미생성 저장소는 absent로, 예상 밖 진단/timeout/spawn/출력 상한은 점검 실패로 구분한다. absent/readable은 전체 Git 기능 확인이나 경로 소유·채택 허가가 아니다.
- WorkspaceService.reserve에서 Git 업무에만 메모리/DB 저장 직전 검사한다. 실패 시 work.workspace/executionPath와 creation/preparation/Git-intent 기록은 없고, 짧은 루트 확인 후 같은 업무로 다시 요청할 수 있다. 기존 업무 재조회·소유 검증·복구, explicit copy는 그대로다. 자식 환경만 LC_ALL/LANG=C로 고정하며 전역 환경·원본 Git·실제 선택 폴더·ACL을 변경하지 않는다.
- 실제 긴 경로의 기존 영구 고정 재현 RED를 확인한 뒤 무예약/기록0/원본 refs 보존/같은 업무 재시도 GREEN으로 검증했다. 한글 UTF-8 바이트 경계, 오류 분류, 자식 환경, 기존 재조회 비호출 회귀를 포함한다.
- 구현자 최종8파일58개 통과(129.49초). 루트 직접 최종 검사: TEMP/TMP=C:/Windows/Temp, scripts/npm.ps1 run test:run --workspace backend -- git-path-preflight workspace-service worktree-create →4파일32개 통과(23.03초). backend build, OpenSpec strict, diff 검사 모두 exit0. 별도 명세 및 품질 리뷰 추가 P1/P2 없음.
- 이 보강은 기존3.1의 발견된 경로/Git 사전 점검 결함 수정이며 완료 개수는25/54 그대로다. 후보 예약5.1도 같은 helper를 재사용한다. 정상 생성 fixture의 CI/전체 검증은 짧은 실행별 runner 임시 경로로 설정하며, 긴 경로는 별도 조기 차단 회귀로 검증한다.

### 출시 전 후속 대조 메모

- 그룹7.3/7.4는 사본 복사 무결성 raw digest와 빌드 산출물/캐시 및 tasks 체크 진행의 의미상 최신성을 구분해야 한다. 현재 보수적 stale 제한을 그대로 활성화·배포하지 않는다.
- 그룹7.6 및9.2는 브라우저 cleanupStatus:uncertain의 영속 플래그만으로 영구 잠금이 남지 않도록 실제 소유 프로세스/Job의 PID·세대 등 재확인 근거 저장과 종료 관찰·복구 동선을 대조한다. 확인 불가를 무조건 해제하거나 타 프로세스를 종료해서는 안 된다. 실행이 종료됐다는 실제 증거로만 정리하며 기존 전반 상태 재확인/종료 UX와 연결한다.

## 2026-10-29: 5.1 통합 요청·별도 후보 예약 완료

- GET/POST /api/work/:id/integration을 추가했다. 엄격한 명시 요청·로컬 target branch·work/target HEAD·검토 버전과 현재 필수 검증 참조를 기록한다. 후보는 WorkWorkspace와 구분한 UUID/root/profile/path이며 현재 확인된 루트에 고정된다. verificationRefs는 빈 목록으로 시작하여 업무 통과를 후보 통과로 복사하지 않는다.
- 동일 requestKey의 저장 결과 재조회는 현재 검토·HEAD·루트·용량·잠금·경로 검사보다 앞이다. 다른 내용의 같은 키는 거부한다. DB transaction에서 공통 저장소별 활성 후보를 하나로 제한하며 failed/uncertain도 슬롯을 유지하고 terminal 이력은 보존한다. 독립 SQLite writer 경합은 409로 구분한다.
- 최신 업무/소스/계획/질문/필수 명령 및 현재 등록 브라우저 근거를 확인한다. 과거 폐기 명령·미등록 브라우저 결과는 요청의 검증 참조에 넣지 않는다. 실제 Git 등록·원본 경계·대상 tip을 재확인하고 새 후보 경로의 하드가드는 DB 예약 전에 검사한다.
- 명세 리뷰가 발견한 P2(같은 공간 index/공유 관리/대상 ref 점유 또는 uncertain 중 예약 허용)를 실제 API RED로 재현했다. 신규 예약의 management + 업무 공간 + 업무/대상 ref 잠금으로 보강하고 finally 해제한다. 독립 B의 공간/파일은 막지 않으며 busy 상태의 기존 요청 replay도 유지한다.
- 루트 직접 검증: 짧은 실행별 TEMP/TMP=C:/Windows/Temp에서 integration-request 전체10개 통과(245.73초), backend build, OpenSpec strict, diff 검사 모두 exit0. npm wrapper가 -t 필터를 전달하지 않아 의도한 일부 대신 해당 파일 전체를 수행했으며 성공 개수는 실제 전체10개다. 구현자도 전체10개(248.63초), 기존 coordinator/lock3파일32개 및 기존 관련5파일30개 통과를 보고했다. 명세/품질 재리뷰 추가 P1/P2 없음.
- queued는 예약 의도일 뿐 실제 디렉터리·브랜치·stage·커밋·merge·반영은 하지 않는다. Git 상태와 DB를 완전히 원자화했다고 주장하지 않으며5.2/5.3은 실제 변경 전에 다시 검사한다. UI 동선/운영 활성화/배포는 여전히 후속이다.

### 다음 단계 전 조회 지연 보강 근거

- 독립 실제 관리 Git fixture(문서4개/코드1개)를2회 측정: path5회/313~314ms, documents5회/305~311ms, planVersion30회/1789~1868ms, WorkController.get79회/4966~4970ms, requireReviewedPlan10회/588~643ms, integrationReadiness88회/5389~6759ms. 예약한 setTimeout(0)도 같은 시간 지연돼 서버 이벤트 루프 차단을 확인했다.
- 4.6의 최적화는 별도 /workspace 메타데이터 조회에만 적용했다. WorkRoom의 work GET과 일반 FileResults.gitReport는 여전히 중복 동기 수집이다. WorkRoom은 SSE 후 묶음 새로고침이며 모든 화면이5초 정기 poll이라고 단정하지 않는다.
- 좁은 보강 계획: 한 동기 읽기 안의 문서 root/내용 일괄 수집, 동일 변경 보고서 및 명령 재사용, capturedRevision을 받고도 버리던 snapshot 계산 제거. 전역/요청 간 TTL 캐시는 쓰지 않고 시작/종료 소유 증명, mutation 직전 및 await 뒤 새 검증, native client.ready/resume 이후 두 번째 검토는 유지한다. 실제 개선 후 같은 fixture로 호출 수·타이머 지연을 재측정하며 잔여 동기 차단도 기록한다.

## 2026-10-29: 업무 조회·검토 중복 동기 Git 검사 보강

- 활성 Git 업무의 planVersion은 한 동기 읽기 안에서 검증한 문서 root·내용을 묶어 읽고 시작·종료의 저장 업무/실제 Git 경로를 새로 확인한다. 문서 해시 순서·체크박스 정규화·full plan 바인딩을 보존하고 공개 document/CAS·완료 이력은 바꾸지 않았다. 전역/요청 간 TTL 캐시와 WorkspaceService.path 변경은 없다.
- WorkController.get은 changes와 changeReport를 동일 보고서에서 만들고 같은 revision/명령을 결과 판정에 재사용한다. ExecutionService.results는 capturedRevision을 받은 경우 나중에 버리던 snapshot을 먼저 계산하지 않는다. full 전용 requireVerifications/readiness는 기본 work 명령 유도를 생략하여 불필요 gitReport 호출2회도 제거했다. 사용자 UI는 두 검증 scope를 유지한다.
- mutation 직전 검사, requireVerifications await 이후 원시 snapshot/계획/업무/질문 재확인, native client.ready/resume 이후 두 번째 gate는 유지했다. 읽기 중 소유/등록/링크/저장 업무가 달라지면 거부한다.
- TDD RED: 문서4→8개에서 경로 검증6→10회 선형 증가, GET 보고서2회, capturedRevision에서도 버리는 snapshot1회, 기본 work 명령 readiness에서 report2회. 수정 후 회귀 GREEN. 구현자 최종10파일73개 통과 및 backend build/diff 성공. 루트 직접검사: cwd backend, project node로 vitest run work-read-performance browser-verification-action-race →2파일21개 통과(22.16초), 이어 같은 project node로 tsc -p tsconfig.json exit0. 명세/품질 재리뷰 추가 P1/P2 없음.
- 동일4문서 최소 fixture2회: planVersion30→10Git/551~561ms, GET79→36Git/1993~2003ms, readiness88→34Git/1907~1949ms. timer 지연도 같은 시간으로 잔여 동기 block은 남는다. requireReviewedPlan의 별도 안전 경계10Git/약0.55~0.64초는 유지했다.
- 변경100파일+full/work 모두 기본 명령 유도 fixture 최종2회: GET146Git/8037·8111ms(cat-file100회), readiness44Git/2511·2584ms(cat-file0회). 큰 diff GET의 파일별 동기 blob 조회는 아직 해결되지 않았다. 출시 전 다음 좁은 보강에서 bounded cat-file batch로 바꾼다. 본 변경만으로 앱의 모든 멈춤이 해소됐다고 보고하지 않는다.
- 독립 측정 스크립트 .tools/git-read-audit.cjs와 임시 fixture만 사용했고 실제 모델/실사용DB/운영 프로세스는 건드리지 않았다. 원본D 변경·13003 재시작·운영 활성화·배포 없음. 기존4.4의 성능 회귀 보강으로 완료 개수26/54는 유지한다.

## 2026-10-29: 기준 blob 일괄 조회와 메모리 상한 보강

- 기준 파일별 cat-file 실행을 읽기 전용 cat-file --batch로 묶었다. 서버가 관찰한 OID/크기만 입력하며 입력32KiB·출력3MiB 단위로 나눈다. 기존 runner의 시간/출력 제한·환경 격리를 보존한다. 헤더·종류·크기·순서·본문 구분·전체 길이를 검증하고 누락·손상·추가 출력은 실패 처리한다.
- 전체 batch 검증 뒤 필수 소비 콜백으로 해시·문자열 또는 binary null 상태로 즉시 변환한다. 리뷰에서 발견한 모든 batch의 원시 Buffer 누적을 제거했다. 동일 blob의 경로별 mode/CRLF/tasks 체크 정규화와 기존 소유·소스 재확인은 유지한다. 전역 캐시는 없다.
- 변경100파일 실제 fixture의 GET은146→47 Git 호출, cat-file100→1회로 감소했다. 독립 두 측정은 약2.75~2.91초였으며 동기 소유 검사 등 잔여 차단은 남는다. 앱의 모든 멈춤 해소를 의미하지 않는다.
- 구현자 관련8파일87개 통과(68.14초). 루트 최종 직접검증: TEMP/TMP=C:/Windows/Temp에서 project node로 vitest run git-blobs worktree-result-batching work-read-performance →3파일45개 통과(27.52초), 이어 backend tsc exit0. OpenSpec strict 및 diff 검사 성공. 메모리 수정 후 명세·품질 재검토 모두 추가 P1/P2 없음.
- 완료 개수26/54를 유지한다. 원본D·운영 DB·실행 서버·활성화·배포는 변경하지 않았다.

## 2026-10-30: 5.2 및 예약 전 API 재시도 보완의 검증 대기

- 5.2는 GET commit-preview/POST result-commit, 전체 파일 선택·검증 소스 누락 차단, 소유 NUL 경로 파일, 부모+선택 내용/mode와 일치하는 immutable tree, commit-tree와 명시 업무 ref CAS, 별도 resultCommit/resultTree 및 전역 PK와 구분한 intent ID를 구현했다. 원본 HEAD와 초기 예약 fingerprint는 유지한다.
- 경쟁 패자의 기록 덮어쓰기, 정리 실패의 lifecycle 누수, CAS 이후 조회 실패의 복구 불가, noop의 부분 저장, 외부 index 변경 유입, 비공개 추적 파일의 변환 실행, ignored/assume/skip 소스 누락을 리뷰·회귀 작성 중 보완했다. 입력 키/선택 경로 순서만 바뀐 동일 요청도 정규화한다. 파일당8MiB 초과·미지원 변환은 안전하게 거부하며 종료 불명은 해당 점유를 보존한다.
- 실행된 중간 결과: 초기20개 통과(460.98초), 후속25개 중24통과/skip-worktree1실패(669.86초), 별도 추적 비공개 filter1개 통과(16.31초). 마지막 실패는 readiness/status 이전 플래그 검사 및 실제 S 비트를 확인하는 fixture로 보완했다. 원인을 Git 자동 정리로 단정하지 않는다. 최신 CAS 복구2개·입력 정규화1개 및 플래그 보완 후 회귀는 아직 실행하지 않았다. 중간 통과를 최신 전체 통과로 계산하지 않는다.
- 별도 실제 /prepare 재현으로 경로 미지원 이후 singleton 요청이 failed로 남아 동일/새 키 모두 재시도 불가임을 확인했다. 공통 읽기 전용 예약 계획과 request 저장 전 점검, 실제 reserve 재점검을 추가했다. 늦은 typed 경로 오류이면서 공간과9종 생성 근거가 모두 없는 경우만 실패 이력을 보존하고 명시적으로 다시 요청할 수 있다. legacy 무코드 실패·copy 실패·uncertain·잔여는 자동 해제하지 않는다. 신규 unit17개/HTTP2개는 아직 실행하지 않았다.
- 추가 Vitest 실행들은 자동 승인 검토 서비스가 'Selected model is at capacity'로 거부하여 프로세스가 생성되지 않았다. 안전성 거부가 아니며 승인 검토를 우회하지 않았다. 기본 sandbox 실행도 esbuild 상위 디렉터리 접근 거부로 시작하지 못했다. 해당 테스트들은 미수행이다.
- 두 수정이 동결된 뒤 루트가 기본 sandbox에서 project node tsc -p tsconfig.json을 직접 실행하여 exit0(2.57초), OpenSpec strict와 diff 검사 exit0을 확인했다. 정적 리뷰는 실행 테스트를 대신하지 않는다. 최종 회귀 전 체크박스·완료 개수·커밋·배포를 완료 처리하지 않는다. 운영D/13003/실사용DB는 변경하지 않았다.

### 같은 날 후속 개발과 환경 대조

- 5.3의 후보 전용 fixed path/identity/pointer/등록 검증, 별도 preview/prepare API, immutable merge-tree 대조·명시 후보 ref CAS, 준비 전체의 영속 관리 intent와 단계별 PID, 실제 충돌 및 응답 유실 관찰 복구를 작성했다. 이미 게시한 후보의 상태·검증 refs·시각은 같은 준비 요청 재조회로 되돌리지 않는다. CAS 뒤 owned MERGE_HEAD 잔여는 실제 근거를 보존하며 자동 merge/CAS/abort/reset을 하지 않는다. 이 단계의 실회귀는 미실행이다.
- 환경 대조로 Git --system의 filter.lfs.clean/smudge/process 정의가 모든 fixture에 상속됨을 확인했다. 대상 파일은 check-attr filter/merge가 unspecified인데도 정의 존재만으로 후보를 일괄 거부하던 코드를 보완했다. target/result 전체 경로의 실제 속성과 선택된 merge.default/custom driver를 검사하며 미사용 정의는 허용한다. Git의 driver 선택 규칙에 따른 builtin 재정의·강제 builtin·미정의 fallback 회귀를 포함해 후보 회귀45개를 작성했다. 실제 시스템/global/프로젝트 설정은 변경하지 않았다.
- 5.4는 candidateId/workId 및 source/project/workspace 관계, 현재 후보·fixed root·상태별 HEAD/MERGE_HEAD 검사를 모든 프로젝트 조회에 연결했다. 일반 후보 쓰기/reconcile은 명시 거부하고 strict/private/localOnly 정책 및 targetHead 기준 metadata를 추가했다. 신규 회귀27개는 미실행이다. 이후5.5 연결 중 candidate file GET의 async Promise를 펼쳐 본문이 누락되는 결함을 발견해 수정과 응답 본문 회귀를 진행 중이다.
- 5.3/5.4의 build·테스트 파일 타입 검사는 구현자가 exit0을 확인했고, 루트도 LFS 후속 보완 전 합쳐진 backend build를 직접 exit0(2.52초)으로 확인했다. 컴파일된 순수 입력 정규화 검사도 기본 sandbox에서 exit0이지만 Git/API 회귀를 대신하지 않는다. 기본 sandbox의 실제 저장소 속성 probe는 CodexSandboxOffline SID와 저장소 소유 SID 차이의 Git 보호로 실패했으며 safe.directory/권한/설정은 변경하지 않았다.
- 5.5 후보 편집·stage·해결 커밋과5.6 화면 연결 준비를 같은 그룹5 안에서 계속한다. 자동 승인 검토 서비스 capacity로 최종 Git/API 회귀가 계속 미실행이므로 검증 완료26/54와 기본 비활성을 유지한다. 그룹5 검증 전 그룹6으로 넘어가지 않는다.

## 2026-10-30: 예약 전 API 실패의 재시도 잠금 수정 검증 완료

- 승인 검토가 루트 명령에 다시 응답하여 동결된 사전 예약 수정의 실제 회귀를 수행했다. 프로젝트 node로 vitest run workspace-provisioner workspace-service git-path-preflight →4파일48개 통과(69.88초), 별도 vitest run workspace-preflight-api →실제 HTTP2개 통과(31.91초). 두 실행 모두 TEMP/TMP=C:/Windows/Temp, exit0이다.
- 최초 긴 경로 거부는 업무 상태·요청·공간·Git 생성 기록·실제 원본 refs/index를 오염시키지 않는다. 짧은 루트로 변경한 뒤 같은 업무·대화에서 동일/새 요청 키로 준비된다. 늦은 typed 오류의 재시도는 공간 및9종 생성 근거가 없는 경우로 한정하고 실패 이력을 보존한다. 기존 공간·copy·legacy 불명·uncertain은 추정 해제하지 않는다.
- 별도 명세·품질 리뷰에서 추가 확정 P1/P2 없음. 커밋 직전 루트가 합쳐진 backend tsc를 기본 sandbox에서 직접 exit0(3.07초), OpenSpec strict와 diff 검사 exit0으로 확인했다. 테스트는 신규 서비스가 포함된 현재 트리에서 실행했으며 운영D/13003/실사용DB를 건드리지 않았다.
- 이 수정은 이미 완료한3.1/3.6의 회귀 보완이므로 완료 개수26/54는 유지한다. 선택 커밋과 후보 편집 실회귀는 별도 실행 중이며 이50개 통과로 대체하지 않는다. 활성화·배포는 아직 수행하지 않았다.

## 2026-10-30: 5.2 선택 결과 커밋 최종 회귀 완료

- 루트 직접 실행: TEMP/TMP=C:/Windows/Temp, project node의 vitest run integration-result-commit →최신29개 실제 Git/API 회귀 전부 통과(785.12초), exit0. 중간25개에서 실패했던 skip-worktree, CAS 뒤 조회 실패·확인된 CAS 거절, JSON key/paths 순서 멱등성을 포함한다.
- 선택 밖/부분 stage·숨은 소스·private/localOnly·필터 경계, 한글·선행 공백·rename/삭제·일반 CRLF, 250파일 NUL 선택, immutable tree 경쟁, 정확한 OID·부모·tree·응답 유실 재조회, 독립 WorkStore 점유와 lifecycle 해제를 검증했다. 후보 준비·후보 편집 통과로 대체한 결과가 아니다.
- 명세·품질 리뷰의 확정 문제를 보완했고, 공개 API와 제한은 docs/API.md에 기록했다. 5.2 범위 controller/store만 index에 분리하여 후속5.3~5.5 미검증 코드를 함께 커밋하지 않는다. 루트가 같은 index의 backend 소스를 .tools의 독립 사본으로 내보내 project tsc를 exit0으로 확인했고, cached diff의 범위와 공백 검사도 확인했다. 현재 작업 파일은 되돌리지 않았다.
- 진행률27/54이며 워크트리 기본 활성화·운영 반영·배포는 아직 수행하지 않았다.
