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

## 2026-10-30: 후보 편집 실제 회귀의 실패와 성능 조사

- 루트가 후보 편집13개와 프로젝트 후보 API27개를 실제 Git/HTTP로 실행했다. 합계40개 중29개 통과·11개 실패(1673.98초)이며 성공으로 처리하지 않는다. 편집9개는120초 제한 초과, API2개는 잘못된 파일 PUT의500 응답과 Windows의 worktree pointer fixture 덮어쓰기 EPERM이었다.
- 편집 state가 업무의 전체 검증 기준을 두 번 확인하고 파일 저장 요청이 여러 state 검사를 중첩하는 경로를 확인했다. 별도 소유 fixture에서 단계별 시간·동기/비동기 Git 호출·이벤트 루프 지연을 측정한다. 제한 시간 증가나 전역 캐시로 가리지 않으며 변경 직전·await 이후의 실제 소스/소유/계획/검증 근거 검사를 유지하는 범위에서 중복 비용을 줄인다.
- 특수 Git 속성을 후보 안에서 편집한 뒤 앱에서 복구할 수 없게 되는 경우와 외부 cherry-pick/revert/sequencer/autostash 상태도 보강한다. 파일 편집과 Git stage/commit의 검증 계약을 구분하되 비밀·경로·소유·CAS 검사는 유지한다. 후보45개 준비 회귀는 별도 실행 중이다.
- 실제 회귀가 통과하기 전5.3~5.5를 완료하거나 배포하지 않는다. 현재 검증 완료27/54, 운영D/13003/실사용DB 미변경을 유지한다.
- 기존 dist의 독립 충돌 fixture 감사에서 후보 file GET은15.36초/동기208·비동기48 Git 호출, file PUT은68.23초/동기855·비동기248회였다. PUT의 state5회가 basis10회/readiness10회/planVersion20회/snapshot30회를 유발했고 raw 파일 수집10회는 합계36.94ms였다. 반복 검증이 주요 비용임을 보여 주며, 아직 수정 후 성능이나 최신 소스 전체 통과를 뜻하지 않는다.
- 같은 감사의 stage는56.18초/동기668·비동기205회, 해결 commit은72.03초/동기857·비동기305회였다. 전체 명시 흐름은 exit0으로 끝났고 두 부모 커밋·원본/업무 HEAD와 index 보존·후보 저장·lifecycle0을 확인했다. 기능이 끝나더라도 총 처리 시간이 길어 기존120초 단위 회귀를 초과하는 문제는 남는다. 이 결과로 최신 후보 편집 회귀 실패를 통과로 바꾸지 않는다.
- 후속 raw 편집·외부 진행 방어 동결 후 루트가 project-candidate-api의 사전 근거 없는 쓰기6종과 root 설정 변경/포인터·branch 변조1개를 직접 재실행했다.7개 통과·25개 의도적 제외(46.64초), exit0으로 기존 잘못된 PUT500 및 pointer fixture EPERM 두 실패가 해소됐음을 확인했다. 나머지 후보 편집·새 보강 회귀와 구분하며 완료율은 유지한다.
- 외부 CHERRY_PICK_HEAD/REVERT_HEAD/sequencer/MERGE_AUTOSTASH/rebase-merge 표시의 조회 거부·보존도 별도 실제 API5개 통과(33.26초), exit0으로 확인했다. 독립 정적 리뷰는 소유 MERGE_HEAD가 같아도 외부 AUTO_MERGE 치환을 관찰하지 않아 merge --quit가 그 복구 ref를 지울 수 있는 P2를 발견했다. 병합 직후 소유 근거를 저장하고 종료/복구 직전에 대조하는 후속 보완이 필요하다. 원본 결과 커밋의 immutable tree 검사만으로 이 복구 메타데이터의 소유를 증명하지 않는다.
- 별도 후보 준비45개 전체 회귀는43개 통과·2개 실패(1801.22초)로 끝났다. 모든 경로에 강제 builtin merge/-merge를 설정한 두 fixture가 미리보기409로 실패했다. target에만 속성을 넣고 result에는 넣지 않아 result의 unspecified가 custom default를 선택하는지 조사한다. 제품 가드를 먼저 완화하지 않는다. 추가한 명시 no-autostash 회귀는 별도1개 통과(43.69초), exit0이다.
- 요청별 full basis 공유의1차 동결본을 루트가 빌드 exit0 후 직접 측정했다. proof unit13개 통과(0.34초), 별도 실제 충돌 감사 exit0으로 두 부모 커밋·원본/업무 HEAD/index 보존·lifecycle0을 확인했다. 동일5소스 파일 fixture의 GET15.36→5.55초, PUT68.23→12.66초, stage56.18→13.54초, commit72.03→18.88초였다. PUT의 full readiness10→1회, 동기 Git855→114회로 감소했다. raw FS와 DB/계획/명령/검증 근거는 checkpoint에서 새로 읽으며 전역 TTL 캐시는 쓰지 않는다.
- 1차 성능본 정적 확인에서 candidate HEAD/progress가 checkpoint await 도중 바뀌는 경우의 최종 재확인을 추가 보강 중이다. 위 수치는 그 보완 전의 중간 측정이며 최신 전체 회귀·최종 성능 보증이 아니다. AUTO_MERGE 소유 근거 보강도 아직 남아 있다.
- 두 immutable commit 모두에 속성을 준비한 fixture 수정 후 강제 builtin merge/-merge 정상2개는 실제 재실행 통과(106.81초), exit0이었다. 후보 최종 checkpoint 후의 정상 흐름2개와 stale/readiness2개는 새 rawIndex가 일반 index 파일을 디렉터리 전용 경로 검사에 전달한 결함으로 모두 실패했다. 독립 리뷰로 원인을 확인하여 부모 디렉터리 검사와 파일 lstat 소유 검사로 나누어 보완 중이다. 해당 상태에서 실행한 AUTO_MERGE2개도 같은 선행 실패이므로 의도한 취약점의 RED 재현으로 인정하지 않는다.
- rawIndex 수정 후 일반 수정 후보의 실제 편집→stage→명시 커밋→재조회→과거 stage 영수증 흐름이117.64초로 통과했다. 같은 실행의 외부 AUTO_MERGE 치환 회귀는 선행 흐름을 마치고 실제200/기대409로 실패하여 의도한 RED를 재현했다. 이를 근거로 소유 복구 ref 대조 보강을 진행한다. 정상 흐름 하나의 통과를 전체 편집 회귀 통과로 보고하지 않는다.
- 추가 대기 콜백이 없는 checkpoint의 중복 read를1회로 줄이기 전 단위 회귀는 기대4/실제6회로 정확히 실패했고, 최소 구현 후13개 전부 통과(0.37초), exit0이었다. 브라우저 freshness callback이 있는 경우의 read→검증→read 및 최초 full gate 전후 read는 유지한다. 최종 후보 비동기 확인 뒤 업무 raw FS/DB의 동기 대조도 유지한다.
- AUTO_MERGE 보강 후 backend 빌드 exit0을 루트가 직접 확인하고 후보46개 및 편집/API/proof 전체 회귀를 실행 중이다. 그동안 backend 소스/테스트를 동결하고5.6 프런트 연결을 진행한다. 새 readonly reservation-preview API의 backend 추가도 동결 해제 후로 미룬다. 프런트 durable 요청 모듈의 초기 RED(모듈 누락)를 실제 확인했다.
- 최종 AUTO 정적 리뷰에서 추가 P2를 확인했다. 명시 reconcile의 quit는 `explicit-merge-finalization` intent인데 완료 관찰은 `merge-finish`만 인정하고 catch가 stage를 덮어 잃는다. 따라서 명시 quit 성공 응답까지 유실되면 실제 종료했어도 다음 reconcile이 영구 uncertain일 수 있다. 동일 소유 root/commonDir/PID의 두 종료 stage를 인정하고 catch에서도 보존하는 별도 보강·실제 회귀가 남아 있으며, 실행 중인 기존 회귀가 통과해도 이 문제를 해결한 것으로 간주하지 않는다.
- 현재 동결한 백엔드의 실제 충돌 감사는 exit0으로 끝났다. 다른 전체 회귀2개와 동시에 실행한 부하 조건에서 GET6.51초, PUT14.92초, stage14.56초, commit21.06초였으며 두 부모 커밋·원본/업무 HEAD와 index 보존·lifecycle0을 확인했다. 이 수치는 이전 성능 수치와 달리 동시 회귀 부하가 포함됐고, 아직 남은 명시 복구 및 외부 정리 완료 관찰 문제의 해결을 의미하지 않는다.
- 전체 편집 회귀의 두 정상 장시간 조합은120초 제한 초과로 실패했다. 매 case에 이미 검증된5.2 준비 API와 stale/replay/영수증까지 중복해 실행하는 fixture 비용을 분석한다. 전체 API 통합 정상 사례는 유지하고 기능별 회귀는 정확한 실제 Git 결과 fixture로 분리하여 보호 검사를 mock하거나 timeout만 늘리지 않는다. 후보 준비의 외부 cleanup 후 순수 관찰 복구도 새 AUTO guard로 거부되는 회귀가 있어, 추가 쓰기 없는 완료 관찰과 실제 cleanup mutation의 경계를 보완해야 한다.
- 프런트 내구 요청3개와 명시 준비/예약 화면2개가 실제로 통과했다(1.39초). 후보 초안·늦은 응답·복구 파일·빈 충돌 커밋 등 추가 회귀는 진행 중이며5개 통과만으로5.6 전체 완료로 계산하지 않는다.
- 후보 화면 연결의 scope 초기화 및 파일 이동 token 누락을 리뷰 후 수정했고, 확장 프런트4파일49개가 통과했다(5.06초). 이후 candidate 초안 test의 act 동기화만 수정하여 해당1개를 다시 실행했고 경고 없이 통과(1.69초)했다. 루트 프런트 프로덕션 빌드도 tsc+Vite exit0(빌드17.81초)으로 확인했다. 기본 sandbox의 첫 빌드는 esbuild 상위 경로 접근 거부로 실패했고, 승인된 동일 명령 실행에서 성공했으며 권한/설정은 바꾸지 않았다.
- 후보·편집 전체 회귀73770/62214는 알려진 관찰 복구 결함과 장시간 조합 timeout이 확인돼 루트가 자신의 테스트 세션만 CtrlC로 중단했다(exit1). 미실행 항목을 통과로 세지 않는다. 운영 서버·외부 프로세스는 종료하지 않았다. 프런트를 동결하고 backend 작성자로 전환해 관찰 복구·fixture 분리·예약 미리보기·확정 사전 거부 응답을 보완 중이다.
- 명시 reconcile quit의 성공 응답 유실 회귀를 실제로 실행하여 intent.stage가 undefined/기대 explicit-merge-finalization인 정확한 RED를 확인했다(96.92초). 확정 사전 거부는 `mutationOutcome:rejected-before-intent`와 exact requestKey를 반환하는 계약이다. client는4xx+marker+저장key 일치에만 knownfailed를 허용한다. 서버는 terminal-only admission/rejection barrier로 늦은 다른 handler의 예약을 막고 새로운 pending busy를 만들지 않는 설계를 진행한다. 초기 경로 거부 후 root 변경의 같은key 재시도 계약은 좁은 generation CAS로 보존해야 한다.
- admission8개·예약 미리보기2개·기존 공간/경로50개를 합친7파일60개가 실제 통과했다(131.14초), exit0이다. 최초 business 예약과 admitted를 같은 transaction에 저장하며 rejected는 늦은 handler를 차단한다. 경로 거부의 같은key/newkey HTTP 재시도도 이 실행에 포함한다. 뒤늦은 unrelated 준비 증거가 wrapper를 우회시키는 추가 race는 별도로 실제 RED(거부 없이 준비됨,12.75초)를 확인해 조건을 좁혔으므로 그 보완의 재검증이 필요하다.
- AUTO/종료 유실·외부 정리 관찰6개 재실행은5통과/1실패(417.66초)였다. stage 소실은 수정됐으나 명시 quit 유실 뒤 살아 있는 host observer claim을 먼저 검사하여 종료한 child를 다시 확인하지 못했다. 끝난 handler 자신의 exact token만 해제하고 child의 종료 불명 intent/lifetime은 유지하여 다음 명시 재확인이 실제 PID 종료를 확인하게 보완 중이다. 이 실패를 해결 전 완료 처리하지 않는다.
- UI 정적 추가 리뷰에서 같은 scope 재진입 후 recover B가 저장한 새 토큰을 늦은 prepare A 응답이 덮는 P2를 확인했다. 프런트 다음 보완에서 attempt 식별자와 현재 receipt의 endpoint/body 비교로 성공·실패 저장을 모두 보호해야 한다. 복구 확인 화면도 실제 전송할 저장 정책을 표시하고 feature-on 준비·토큰 갱신 UI 회귀를 추가한다. 현재 추가 구현은 미완료다.

### 2026-10-30 추가 실제 검증과 게이트웨이 수정
- 예약/결과 커밋 실제 Git·API 회귀는 42개 모두 통과했다(1043.96초). frontend 최종 관련 66개, 타입 검사 및 Vite build도 통과했다. backend build도 통과했다.
- Codex 내장 브라우저의 별도 QA 사본에서 저장 루트 검사·저장, 문서 검토, Git 업무 공간 준비, 사본 파일 편집·저장 및 등록된 실제 전체 검증 통과를 확인했다. 운영 13003과 D: 원본/운영 DB는 조작하지 않았다.
- 실제 QA 조회에서 재사용 upstream 소켓의 ECONNRESET이 downstream 취소보다 먼저 발생하고 살아 있는 응답에 503을 반환하는 순서를 확인했다. 매 요청 새 연결을 사용하며 자동 재전송하지 않도록 수정했다. 통제 HTTP RED(200/503/200) 이후 GREEN(200/200/200), 정확한 GET 2회·POST 1회 전달, 취소·인증·질문 유지 등 7개 회귀와 build, 독립 코드 리뷰를 통과해 943543f로 커밋했다. 운영 배포는 아직 하지 않았다.
- 편집/후보 조회/proof 전체 84개 시도는 64개 통과·3개 실패·17개 미실행, worker 예상치 못한 종료 1건으로 끝났다. 이를 전체 성공으로 계산하지 않는다. 실패 3개는 기존 POST 생성/이동 응답 201을 200으로 잘못 기대한 테스트 단정이었다. 제품 응답은 유지하고 정확한 201로 고쳤다. 나머지 동작을 재검증하고 있으며, 한 복원·이동 통합 케이스는 120초 제한을 초과해 원인을 분리하고 있다. 남은 17개는 별도 worker 8개/9개로 나눠 검사한다. 시간 제한을 늘려 성공 처리하지 않았다.
- 이후 분리 실행에서 미실행 proof 8개(375.95초), 복구/marker 9개(575.48초)가 모두 통과했다. 3개 201 단정 수정 후 속성 raw edit/delete의 후속 검사도 각각 통과했다. 복원·이동 한 케이스의 timeout은 필수 mutation을 유지하고 응답 CAS 버전을 다음 요청에 직결하여 중복 preview/entry 조회를 없앤 뒤 재검증 중이다. 장시간 worker 종료 원인은 exit code/signal 증거가 없어 확정하지 않았다.
- 별도 실제 IAB QA에서 통합 예약과 선택 결과 커밋까지 진행되었고, 화면 재조회 후 같은 요청 영수증과 결과가 복구됐다. 원본 HEAD/index 보존도 확인했다. 느린 주기 조회가 응답 전에 중첩되는 경로를 추가로 조사했다. 실제 지연 GET 회귀는 12초 동안 기대 동시 1개 대신 8개 요청을 만들어 RED를 확인했다. App/업무·문서 조회를 동시 1개와 최신 후속 1개로 합치고 읽기 GET에만 30초/화면 종료 취소를 적용했다. mutation 재전송·시간 제한은 변경하지 않았다.
- 저장된 mutation의 requestKey와 응답 대기를 POST 전에 표시하도록 보강했다. 이 보강의 root 독립 회귀는 frontend 15파일136개 통과(36.31초), Vite build 통과(22.89초)다. 리뷰에서 알림 진입 조회가 같은 큐를 우회하는 P2 하나를 발견해 추가 보완 중이다. 이 상태를 최종 UI 검증/배포 성공으로 계산하지 않는다.
- 중복 조회를 제거한 실제 정상 병합/충돌 해결 2개와 복원·이동 전체 체인 1개는 3/3 통과했다(313.98초, 각 98.7/104.7/109.3초). 모든 실제 mutation·CAS와 두 부모/tree/원본 및 업무 HEAD·index 보존 검사는 유지했다. 부하에서 60초를 초과했던 후보 준비 잠금 검사는 단독 재실행 53.9초로 통과했다. 해당 중단 실행을 전체 성공으로 합산하지 않고 기존 후보 매트릭스와 수정 후 추가 회귀를 조합하여 범위를 확인했다.
- 5.3~5.5를 검증 완료로 기록하여30/54다. 5.6의 UI·브라우저 최종 확인과6~9단계, 운영 활성화·배포는 아직 미완료다. 알림 조회 큐 보완 후 root 독립 관련68개 및 frontend build(24.12초), frontend 타입 검사와 backend build도 통과했다. 리뷰P2 재검토에서 추가 중요 문제는 없었다.
- 실제 후보 UI에서 충돌 표식 파일을 열어 후보에만 해결 내용을 저장했다. 전체 흐름 중 후보 저장 응답이 60초 이상 걸리는 경우가 있어, serial API 측정과 실제 화면 부하를 구분한다. 이 QA는 게이트웨이와 API를 한 테스트 프로세스에서 구동하므로 설치 환경 지연과 동일하다고 단정하지 않는다. 숨겨진 업무 화면의 주기 조회와 보드의 주기 4개 조회가 소스 편집 중에도 남아 있음을 확인해, 대화·SSE·초안을 유지하면서 보이지 않는 화면의 fallback 조회만 멈추는 보완을 진행한다. 이 시점에 모든 멈춤 증상이 해결됐다고 보고하지 않는다.
- 후보 소스의 복사 공간 안내 fallback과 일반 Git의 외부 merge 정리 안내는 후보 절차와 혼동될 수 있어6.5의 최종 후보 표시·원본 반영 UI 작업에서 조정할 항목으로 남긴다. 실제 후보 접근 경로·종류·브랜치는 별도로 표시되며 일반 Git 변경 API 잠금은 유지한다.
- 숨긴 업무 화면/통합 패널의 fallback 조회와 보이지 않는 보드의5초4GET fallback을 멈추되 SSE 질문·대화/문서 초안을 보존하도록 보완했다. 실제 지연 응답 RED3건 후 새 회귀를 포함한 agent129개, root 독립 관련98개(23.25초), build(21.76초), 타입 검사와 중요 코드 리뷰를 통과했다. 화면 복귀는 읽기 조회만 수행하고 새 업무·재연결 POST를 만들지 않는 회귀를 포함한다. 최신 frontend 번들은index-DW4zF0Bv.js다.
- 5.6의 UI/API 흐름·초안 격리·확정 전 자동 실행 금지·CAS 실패/영수증 보호와 문서화를 검증 완료로 기록하여31/54다. 실제 IAB에서는 후보 충돌 파일 저장·stage 후 미해결0과 같은 요청키 완료 영수증을 확인했고, 두 부모 해결 커밋 요청을 진행했다. 전체 브라우저 동선 완료는9.5에서 별도 확인하며 운영 배포와 동일시하지 않는다.
- 내장 브라우저에서 후보 해결 커밋26a5368ffee416263a1f661820a3c8a2b57826cd와 미해결0/깨끗한 Git 상태 및 validating 표시를 확인했다. 별도 읽기 전용 Git·SQLite 대조로 부모가 대상f2289d4…와 업무결과8a55c522…의 정확한 두 커밋임을 확인했고, 원본/업무 HEAD·index·실제 파일 및 원본 제외 파일이 보존됐다. proof는 ignored .tools/qa-candidate-proof-20261030.json에 기록했고 화면은 허용된 시각화 폴더의 candidate-resolved-20261030.jpg와 candidate-validation-needed-20261030.jpg에 저장했다. 새 UI로 다시 열어도 같은 후보·요청 영수증·해결 내용이 유지됐으며 후보 통과/원본 반영으로 자동 전환되지 않았다.
- 6.1 후보 명령 검증을 구현 중이다. 미구현 API404의 실제 RED(55초) 후, 실제 후보 cwd/Node/Job·same-key·stale·원본 및 업무 보존 첫 GREEN(43.31초)을 확인했다. 리뷰에서 오래된V1 조회가V2 epoch의 ready/refs를 덮는 P1과 host NODE_OPTIONS가 Job 준비 전 후보 bootstrap을 실행하는 P2를 각각 실제 RED(27.58초/21.30초)로 재현했다. 이 신규 미배포 코드의 두 경계를 보완하고 전체 새 회귀를 확인하기 전6.1 완료로 처리하지 않는다.
- 실제 QA 사본의 작업이 모두 멈춘 상태에서 테스트 화면의 주기 요청을 중지하고 본인이 만든 QA 서버만 종료했다. 운영13003과 원본 앱에는 이 조작을 적용하지 않았다. QA 데이터와 대화 식별은 보존하여 다음 단계에서 같은 사본으로 재개한다.
- 6.1 새 실제 Node/Job/Git 회귀18개는 모두 통과했다(437.71초). 정상/실패·중단·동일 요청·필수 브라우저 미실행 차단·target/work/계획/명령 변경·실행 중 변경·가드 부재·PID 저장 실패·종료 불명 재시작·이전 조회/실행의 새 세대 침범·Node preload 경계를 포함한다. 기존 실행/런타임/대화 복구18개도 별도 통과했다(6.11초). 해당 P1/P2 수정 재리뷰에서 추가 중요 문제는 발견되지 않았다.
- 마지막으로 durable 검증 근거에 준비 정책·실제 런타임 명령 해석 버전을 명시하여 완료 후 변경을 stale로 만들고, 소유 Job 종료를 실제 확인했으나 종료 receipt 저장이 일시 실패한 live instance의 명시 복구를 보강한다. 관련4개 실제 RED를 먼저 실행 중이며6.1 완료 체크는 아직 하지 않는다. actual runtime 바이너리 전체 fingerprint·npm 후보 의존성/산출물 출처·후보 브라우저 실행은7/9.3의 후속 경계다. work 의존성 공유·자동 install·원본 실행으로 우회하지 않았다.
- 6.1 마지막4개 RED는 sourceMutationVersion/준비정책/실제 런타임 해석 변경 뒤 과거fresh=true 3건과 종료 receipt 유실 뒤 running 고정1건을 각각 재현했다(총98.62초). 정책·runtime·명령 해석을 durable basis에 명시하고 동일 live owner의 runGeneration/hostPID/workerPID/fingerprint/확인된 종료 evidence만 transaction CAS로 interrupted 보존 후 자기 잠금을 해제하도록 보강했다. 재시작·다른 owner·DB 재실패는 해제하지 않는다.
- 수정 후 root 추가4개와 영향10개를 묶어14/14 통과했다(315.69초). 이전 전체18개와 함께22개 테스트 범위를 검증했으며 최신 단일22개 전체 실행으로 표현하지 않는다. 최종 backend build 및 중요 코드 리뷰도 통과했다. 6.1을 완료하여32/54로 기록한다. 다음6.2 원본 반영 전 검사와6.3 ff-only 적용·6.4 복구·6.5 화면,7~9단계 및 실제 배포는 미완료다.
- 6.2 원본 반영 사전 검사 첫 전체37개가 통과했다(541.72초). 실제 반영·의도 예약 없이 원본/업무/후보의 HEAD·index·파일·기존 실행 기록을 보존하고, 비겹침 dirty·진행/lock·다른 checkout·오래된 검증·변조 소유 접근을 차단했다. 첫 정상 테스트의 기존 생성 intent가 없어야 한다는 잘못된 단정은 검사 전후 동일성 비교로 고쳤다. 이 단계도 원본 반영 기능·배포 완료로 계산하지 않는다.
- 추가 실제 Git 검사에서 외부 attributesFile 내용 변경 뒤 ephemeral proof가 유지되는 RED와, 속성 guard 뒤 동일 길이 파일 변경 시 원본 status가 clean helper를 실행하는 RED를 재현했다. 실제 check-attr 결과를 버전에 묶고 원본 status를 bounded HEAD/index/blob/mode 비교로 대체하여 두 경계의 GREEN을 확인했다. Git 자체가 dirty로 보는 config 전환 직후 CRLF를 잘못 허용하는 RED도 확인한 뒤 index cached-size 검사를 보강하여 GREEN을 확인했다. 정상 CRLF fixture는 실제 LF commit과 Git checkout으로 구성했다. 처음 테스트 파일의 literal 줄바꿈과 checkout noop 때문에 생긴 fixture 실패를 제품 결함으로 계산하지 않는다.
- 공유 속성 guard 추출의 기존 후보 raw FS 편집/삭제 복구2개는 통과했다(168.27초). 추가 리뷰의 bare CR binary 오판과 업무 snapshot의 mode 확인용 Git diff가 work-only clean helper를 실행하는 경로는 각각 실제200/409 불일치와 marker 생성으로 RED를 확인했다(해당4개 실행63.92초에서2통과/2실패). 이 두 보강 및 수정 후 회귀가 남아 있으므로6.2는 아직 완료 체크하지 않았다. 운영13003·원본 DB·사용자 프로세스는 조작하지 않았다.
- 위 RED 보강 후 root 경계9개는 모두 통과했다(131.63초). 원본 직접 검사는 bare CR·비출력 제어문자의 모호한 자동 정규화를 거부하고, 공유 snapshot은 내용 비교용 Git diff 없이 core.filemode에 따라 mode를 읽는다. 최신 backend build와 diff --check도 통과했다. 기존6.1 후보 status의 guard 경쟁 경로는 아직 별도이며7.6 공통 실행 경계에서 다룬다. 또한 전체 API가 원본 직접 검사보다 먼저 수행하는 기존 collectFiles의 whole-buffer 수집은9.2 자원 한도/스트리밍 보강 대상으로 유지한다. 새 원본 직접 검사 한도를 전체 API의 메모리 상한으로 표현하지 않으며, 이 두 미완료 경계를 해결하기 전 운영 활성화·배포하지 않는다.
- snapshot의 ls-files index 조회도 저장소 FSMonitor hook을 실행하는 실제 marker RED를 확인했다(10.12초). snapshot의 index/config 조회에 FSMonitor 비활성화를 명시했고 최신 backend build가 통과했다. 소스·테스트를 동결하여 새 사전 검사47개와 기존 worktree-results7개를 단일 worker로 순차 실행 중이다. 이 실행 결과가 확인되기 전 전체 통과로 계산하지 않는다.
- 위 순차 실행은 새47개 모두 통과, 기존 결과6개 통과/모드 수집 경쟁1개 실패로 전체53/54였다(718.34초). 기존 spy가 명령 첫 인자만 가정해 변경을 주입하지 못하는 부분을 옵션 독립 조건과 주입 횟수 검사로 보강했지만, 그 뒤에도 실제 경쟁 회귀가 실패했다(7개 중6통과,38.43초). 공유 snapshot의 index 조회와 mode/config 수집 사이 변경을 반환 전에 재대조하도록 보강 중이다. 단순 테스트 가정 수정만으로 해결된 것으로 보고하지 않는다.
- 공유 snapshot이 mode 수집 전후 raw index를 대조하도록 보강했다. 그 뒤 기존 결과7개와 영향받는 정상 사전 검사·private untracked fence·원본 속성 경쟁·두 core.filemode 정책·FSMonitor/clean helper 차단을 묶은14개가 모두 통과했다(129.92초). 최신 backend build와 diff --check도 통과했다. 앞선47개 전체와 마지막14개 영향 재검증을 구분하며, 최종 단일54개 전체 성공으로 표현하지 않는다. 실제 후보 CLI/다른 업무 질문 격리2개를 추가 확인 중이다.
- 마지막 실제 후보 CLI cwd/최신성 및 다른 업무의 질문 대기·후보 점유 격리2개도 통과했다(54.50초). OpenSpec strict validate도 통과했다. 6.2의 원본 확정 전 검사와 보존 계약을 완료하여33/54로 기록한다. 6.3 실제 ff-only 반영·6.4 복구·6.5 UI와7~9단계는 미완료이며, 앞서 명시한 기존 공통 실행/메모리 경계의 운영 활성화 금지는 유지한다.
- 6.3 실제 원본 ff-only 반영 API는 미구현404의 RED(16.34초) 후 정상 ff·실제 HEAD 저장·업무/후보 보존 GREEN(22.86초)을 확인했다. 이어 replay 우선·별도 Store 동시성·원본 최종 변경·ignored 충돌 보존·hooks/FSMonitor/autostash 금지·Git 전후/DB 실패·A/B 순차 반영·두 core.worktree 변조13개가 모두 통과했다(279.31초). 최신 backend build도 통과했다. 다만 추가 리뷰에서 원본 전용 attrs가 후보 새 경로에 smudge를 적용하는 경계와 마지막 fence 뒤 외부 checkout으로 ff 대상 branch가 바뀌는 경계를 발견하여 실제 RED와 보강을 진행한다. 6.3은 아직 완료 처리하지 않았다.
- 두 추가 P1은 실제 marker 생성과 다른 branch ref의 잘못된 전진으로 모두 RED를 확인했다(43.55초). 후보 전체 경로를 원본 현재 속성과 후보 tree 속성으로 검사하고 최종 fence에 묶은 뒤 smudge 회귀가 GREEN이었다(23.24초). branch 보호는 실제 Windows 진단에서 HEAD를 FileStream Read/FileShare.Read로 연 상태의 정상 ff 성공과 외부 checkout HEAD 갱신 거부를 확인하여, 기존 waiting worker/Windows Job과 native HEAD handle을 묶는 방식을 선택했다. 원본 Gitdir/index/config를 그대로 쓰며 Job의 실제 프로세스 종료 확인 후 handle을 해제해야 한다. 외부 checkout 자체의 파일/index 선행 변경을 완전히 막거나 모든 중간 변경 이력을 사후 탐지한다고 주장하지 않는다. 최종 불일치는 uncertain 보존하며 자동 reset/retry하지 않는 범위다. 구현·회귀 완료 전6.3 체크는 유지한다.
- 새 C# guard는 같은 열린 HEAD FD의 expectedRef를 확인하고, Job READY와 PID 기록 후 마지막 fence를 통과해야 Git을 dispatch한다. 소유 Job의 active process=0 확인 뒤 QUIESCENT를 보낸 후 HEAD handle을 닫고 Node는 stdio close까지 기다린다. 실제 새 guard 컴파일 후 핵심3개가 통과했다(64.66초). 구형 guard fixture를 테스트 안에서 직접 컴파일하도록 자급화한 뒤 전체19개가 모두 통과했다(406.82초). 새 경로 smudge·보호 전후 branch 경쟁·외부 최종 index/files 변경의 uncertain 보존·waiting PID 저장 실패·구형 모듈 차단을 포함하며 리뷰에서 추가 중요 지적은 없었다. 마지막 Windows mixedcase GIT env 주입 경계와 기존 공통 Job 영향 회귀를 확인하기 전6.3 완료 체크는 하지 않는다.
- 마지막 mixedcase git_index_file 주입은 원본 밖 index 복사본의 실제 SHA256 변경으로 RED를 확인했다(21.89초). 기존 위험 GIT env 이름만 대문자로 정규화해 제거하도록1줄 보강했고, 새 실제 경계와 정상 ff2개가 통과했다(49.73초). GLOBAL/SYSTEM 등 기존 허용 Git 정책은 바꾸지 않았다. 최신 backend build·diff --check도 통과했으며 기존 후보 CLI/질문 대기·중단/PID 저장/부팅 옵션/종료 receipt 영향6개를 확인 중이다. 전체19개와 최종2개 영향 재검증을 최종 단일20개 전체 실행으로 표현하지 않는다.
- 마지막 공통 Job 영향6개도 통과했다(159.76초). 실제 후보 cwd/최신성·다른 업무 질문 대기와 취소·가드 없음·PID 저장 실패·호스트 Node 옵션 격리·live 종료 receipt 복구를 포함한다. 6.3을 완료하여34/54로 기록한다. 6.4의 재시작/응답 유실 실제 상태 재확인과 취소,6.5 화면 및7~9단계는 미완료이며 운영 활성화·배포는 수행하지 않았다.
- 6.4는 기본 apply/status의 미구현404 RED(22.42초) 후 cheap GET의 Git0/기록 불변 GREEN을 확인했다(67.14초, fixture 포함). 이 API는 기본 DB/live 조회와 명시 inspect=1의 실제 관측을 분리한다. 실제 Job 종료 witness와 row/intent/owner/generation CAS, 논리 취소를 구현해18개 전체 회귀를 실행 중이다. App/Store를 다시 생성하여 같은 영속 DB를 여는 검증과 실제 OS/Node host 강제 종료 검증은 구분하며 후자는9.2 범위로 유지한다. 리뷰에서 업무/후보 파일 및 원본 worktree topology의 최종 reconcile fence 누락2건을 발견하여 실제 RED/보강을 예정했으므로6.4는 아직 완료 처리하지 않는다.
- 6.4 최초 전체18개는 모두 통과했다(336.55초). 뒤이어 관측 뒤 업무/후보 파일·등록 변경3개와 종료 witness의 PID tuple2개를 실제 RED로 확인하고 보강 후 해당6개가 통과했다(73.02초). 과거 반영 뒤 새 업무/후보 편집을 되돌려야만 복구되는 경계2개와 일반 반영의 최종 파일 fence 누락1개도 실제 RED(66.11초)로 확인했다. 명시 과거 관측은 현재 파일을 새 fence로 잡고 sideChanged로 구분하며 일반 반영은 기존 기준의 엄격한 보존 검사를 유지하도록 보강했다. 새 편집 보존 계약은 설계·명세·작업 목록과 API/사용 문서에 일치시켰다.
- 명령 도구의 일시 무응답 뒤 연결을 회복하고 기존 작업 사본을 다시 연결했다. 소스·테스트를 동결한 최신 복구24개와 witness3개의 전체27개가 모두 통과했다(642.94초). 잠금/coordinator26개도 통과했다(12.08초). backend build와 diff --check도 통과했다. 다만 최종 리뷰가 publish CAS 실패의 outer catch에서 다른 프로세스의 복구 완료·새 attempt를 old memory로 uncertain 덮어쓰기 하는 경계를 추가 발견했다. 이 경계는 별도 실제 RED와 최소 보강을 진행하며6.4 완료 체크와 운영 배포는 아직 하지 않았다. 저장 DB의 App/Store 재생성을 실제 OS/host 강제 종료 검증으로 표현하지 않는다.
- late fallback의 terminal failed·old intent를 남긴 새 attempt·같은 identity의 최신 uncertain 관측3개 모두 실제 DB journal 덮어쓰기로 RED를 확인했다(72.81초). 자기 write transaction 안에서 전체 row/intent/request digest를 캡처하고 commit 성공 후 채택하여 fallback의 동일 transaction에서 CAS하는 최소 보강을 적용했다. 새3개와 정상 반영·응답 유실 복구·failed 복구·Git 전후 실패·DB 저장 실패·PID 저장 실패의 영향7개를 묶은10개가 모두 통과했다(238.80초). 최신 backend build와 집중 재리뷰도 통과했다. 앞선 전체27개와 최종10개 영향 재검증을 최종 단일 전체30개 통과로 표현하지 않는다. 6.4를 완료하여35/54로 기록하며 다음은6.5 화면이다. 운영 활성화·배포는 아직 수행하지 않았다.

- 6.5의 후보 CLI 검증·명시 사전검사/반영·저장 영수증/현재 관측·실행 중단/논리 취소·과거 후보 조회 화면을 연결했다. strict body 제어 요청은 별도 로컬 영수증에 정확한 payload를 저장하며 nested uncertain과 동일 요청 재확인을 구분한다. 업무 문서/후보 소스 초안 보호, 후보 안내와 일시 조회 오류의 분리도 연결 중이다. 최초 위임 검증은 exactMutation2·Lifecycle4·ProjectWorkspace40 중45통과/후보 안내1실패였고, C 사본 일반 쓰기와 compiler cache EPERM으로 작업자가 작성을 동결했다.
- 이후 root가 명령별 정식 승인으로 미반영 안내3곳만 수정했고 해당 실패1개가 통과했다(1.51초). OS·폴더 권한이나 보안 설정을 변경하지 않았다. 추가 확인된 화면 전환 뒤 loading 잔류·불완전 status의 렌더 오류2개, timeout 없는 상태 조회의 후속 읽기 차단·과거 applied를 최신 완료 기준으로 쓰는 경계2개, 후보 편집 세대가 바뀐 뒤 늦은 검증 응답 수용1개를 각각 실제 RED로 확인하여 보강했다. 기본 상태 조회만 coalesce/poll하고 기존 GET 전용30초/unmount 취소를 연결하며 POST 자동 중단·자동 재실행은 추가하지 않았다.
- 마지막 영향 회귀는 Lifecycle8와 WorkspaceFlow12의20개가 모두 통과했다(2.70초). 이 외 unchanged exactMutation2와 기존 ProjectWorkspace39의 근거는 재사용하며, 최종 전체62개 단일 실행으로 표현하지 않는다. 프런트엔드 최종 tsc/vite build도 통과했다(주 번들 index-BlUHKNOs.js, Vite16.78초). 단, Git complete는 아직 copy application journal을 요구하는 FileResults.freeze의 후속8.5 연결이 남아있으므로6.5를 완료 체크하지 않는다. 진행률35/54와 기본 비활성 상태를 유지한다. 내장 브라우저 열기는 queued만 확인했고 새 UI 실제 조작·화면 검증 성공으로 계산하지 않았다.
- 반복 턴 중단은 read_thread의 실제 종료 기록에서 `Selected model is at capacity. Please try a different model.`을 확인했다. 모델 실행 용량 오류·명령 도구/일반 쓰기 오류·의도된 결함 재현 RED를 구분한다. 사용자가 확인한 PC 앱 실행 여부만으로 이 모델 서비스 오류를 로컬 앱 종료로 판단하지 않는다. 소스와 b707a10 커밋은 보존됐으며 모델 임의 전환·설치·서비스 재시작·외부 배포는 하지 않았다.
- 7.1 신규 내부 VerificationEnvironments 계약을 추가했다. 기존 ProjectResolver의 실제 등록/identity/HEAD와 VerificationSnapshots의 실제 bytes, 계획 revision을 재사용해 업무·후보 ID/세대·경로·commit·소스/계획/설정·단일 origin·호스트 data/evidence를 고정한다. 캡처 전후 및 assertCurrent에서 재검사하며 임의 path/명령/build 입력과 타 소유 조합, 호스트 데이터의 양방향 physical overlap을 거부한다. 디렉터리 생성·서비스/runner/HTTP/CLI 연결·프로세스 실행은 추가하지 않았다. build는 unprepared/null이고 readiness blocked이며 ownershipScope는 registered-target-at-capture로 한정한다. 첫 import RED(190ms, 테스트 실행0) 뒤 실제 Git/legacy copy 계약6개가 통과했다(21.62초). backend build도 통과했다. 7.1을 완료하여36/54로 기록한다. 실제 빌드 출처·사본 실행·최신성·mailbox·Job 연결은7.2~7.6 후속이며 이 계약만으로 실행을 허용하지 않는다.
- 7.2·7.3은 공통 환경 resolver→호스트 사본→worker/runner의 새 서버·data/evidence 연결과 `openspec/browser-build.json` 출처 계약을 함께 구현했다. 호스트 사본 소유/marker/실경계를 확인한 뒤 선언된 출력 파일만 제거하고 새 빌드하며, 같은 origin의 identity·실제 artifact 바이트를 준비/통과 직전 대조한다. 기존 Scenario JSON은 유지하고 companion 미지원은 blocked다. snapshot 입력 비교는 유지하고 exact attested output/identity/필요 부모만 허용하며 원본·업무·후보에 build를 실행하지 않는다. FileResults의 실행 경로 직접 선택은 제거했고 기존 assertSourcePlan만 유지했다. 별도 a16fa882 개선 분기는 병합하지 않았다.
- 첫 import RED(210ms, 테스트 실행0) 뒤 새 사본/Node/HTTP 계약11개가 통과했다(1.78초). optional data/evidence 경로의 TypeScript 오류2곳을 확인했으며 첫 localconst 보강 뒤에도 종료 helper의 제어 흐름 인식 문제가 남았다. typeof 가드에서 직접 throw하는 한 줄로 실제 거부를 명시한 후 backend build가 통과했다. 런타임 로직이 같은 계약11개는 반복하지 않았다. 신규 actual service3개도 기존 D 프로그램 전용 Chromium/guard로 통과했다(47.96초). work/candidate 각각 새 사본·서버·data·증거·buildId, build 실패의 입력 전 blocked, 실행 중 artifact 변경의 최종 blocked를 확인했다. 신규 설치·다운로드나 원본 D runtime 수정은 하지 않았다.
- 기존 runner 정상 fixture와 service 등록 fixture2개의 실제 호환 RED를 확인했다(1.17초). host snapshot/build 입력과 등록 source/config가 없는 시험용 접점이 원인이었고 제품 가드를 완화하지 않았다. 시험용 helper/server/등록 정보만 보강한 후 기존 runner7개가 모두 통과했다(60.17초): 저장·새로고침·캡처, 의도된 예상값 실패, 모호한 요소/외부 통신, 점유 포트/사용자 중단, 다른 포트 redirect 전 차단, SSE/WebSocket, 동일 origin redirect다. 별도 service의 대화 보존1개(1.02초)와 실제 Nest API 등록/업무 경계1개(1.80초)도 통과했다. 새11·실제3·기존7·선택2의 근거를 합쳐 단일 최종 전체 테스트로 표현하지 않는다. 7.4 후보 ready/구형 근거/cheapstatus/semantic freshness와7.5 mailbox,7.6 종료/점유 복구·기존 candidate cleanhelper 경쟁은 아직 미완료다.
- 문서의 새 빌드 스크립트/서빙 계약과7.2·7.3 완료 조건을 대조하고 해당 두 항목만 완료하여38/54로 기록한다. 6.5·7.4 이후 항목을 완료로 대신 표시하지 않는다.

- 6.5·7.7의 남은 읽기/요청 복구 경계: 새 exact mutation hook은 서버에서 작업이 끝났어도 원래 POST 응답이 계속 대기하면 로컬 busy가 남아 읽기·재확인 버튼까지 잠길 수 있다. 아직 실제 회귀·수정 전이며 해결로 보고하지 않는다. 후속 UI는 읽기와 쓰기 busy를 분리하고, GET에서 동일 work/candidate/requestKey와 입력 버전·확인된 terminal 결과를 관측한 경우에만 로컬 영수증을 종결하는 방안을 검증한다. 로컬 attempt nonce를 새로 고정해 늦은 원응답/이전 finally가 새 상태를 덮지 않도록 해야 하며 POST timeout·자동 재전송·새 요청 키로 우회하지 않는다.
- 7.4는 대상 namespace별 SQL LIMIT10 cheap 조회와 명시 inspect를 분리했다. 기본 조회는 Git·전체 파일 스캔·전체 records를 읽지 않고 not-checked를 반환한다. 실제 guard/child 종료 뒤 새 빌드·환경 tuple과 raw 실행 revision/commit을 보존하며 별도 semanticBasis를 생성한다. Work 결과 commit만의 이동은 재사용할 수 있지만 후보 ID/세대/commit/실제 target ref는 엄격하게 묶는다. tasks 체크 표시 정규화는 companion의 명시 독립성 선언이 있을 때만 허용한다. IV ready/apply는 최신 CLI와 동일 후보 browser proof를 함께 요구하며 새 row/epoch/ref에 대한 최종 CAS를 유지한다.
- 상태 조회 최초 RED3개 뒤 구현 첫 검사에서 구형 passed 거부1개는 통과했으나 새 SQL의 payload-only 파싱으로 기록 ID가 빠진2개가 실패했다(770ms). SQL id/workId를 권위 있는 envelope로 복원하고 테스트 기대는 유지했다. 최종 상태3개와 실제 Git/Chromium semantic7개의10개가 모두 통과했다(120.22초). commit-only 재사용·기본 checkbox 무효화·후보 epoch/실제 target ref 변경·CLI+후보 browser 결합·늦은 epoch/row 응답·명시 checkbox 예외와 본문/코드/AGENTS/deps/설정 무효화를 확인했다. scenario는 configVersion의 파싱된 입력에 포함되며 별도 scenario 변경 실행은 이번 묶음에 포함하지 않았다. 최종 backend build와 diff --check도 통과했다. 7.4를 완료하여39/54로 기록한다. 전체 테스트·실제 내장 브라우저 UI 검증·운영 설치/배포·서비스 재시작은 수행하지 않았다. 7.5~7.7과6.5/그룹8~9는 미완료이며 별도 a16fa882 분기를 병합하지 않았다.
- 6.5·7.7의 POST 응답 무기한 대기 때문에 읽기까지 잠기는 경계를 실제 UI RED로 확인했다(1.11초). 읽기 busy와 변경 요청 busy를 분리하고 GET의 동일 work/candidate/requestKey+expectedVersion 또는 candidateVersion, 실제 processTerminated, 반영 live=settled를 만족할 때만 로컬 영수증을 종결한다. run 제어는 동일 runId에 한정한다. 새 로컬 attempt nonce와 훅 operation 세대로 늦은 원응답·finally가 새 요청을 덮거나 대기를 해제하지 못하게 했다. POST abort·timeout·자동재전송·새 키 우회를 추가하지 않았다.
- 최초 관련 화면9개+exact 영수증2개의11개가 통과했다(1.90초). 새 불일치/종료 미확인/새 시도 CAS 및 늦은 finally2개도 통과했다(1.74초). 화면 재마운트 사이 같은 시도 응답이 저장소에서 먼저 끝난 경계는 추가 실제 RED(731ms) 뒤 동일 시도 CAS를 유지한 보완으로 영향4개 통과(1.82초)를 확인했다. 훅 의존성 정리 뒤 세대/늦은 응답 영향3개도 통과했다(1.26초). 별개 실행의 근거이며 최종 단일 전체14개 실행으로 표현하지 않는다. 수정한4개 source lint는0error/기존 generation cleanup warning1개다. 최종 프런트 build도 통과했으며 실제 내장 브라우저 조작·운영 배포 검증은 하지 않았다. Git 완료8.5와 브라우저 화면7.7 나머지가 남아6.5·7.7 체크는 유지하고39/54다.
- 7.7 화면의 기본 cheap 조회가 fresh=false/not-checked를 무조건 stale로 표시하고 실행 POST 대기 중 조회까지 막는2개를 실제 RED로 확인했다(2.10초). 기본 조회의 최신성 미확인과 명시 inspect=1의 현재 일치 판정을 구분하고 대상·환경 ID·실제 attestation buildId·실행 당시 commit을 표시한다. 역사적 environment.build=unprepared를 실제 빌드 결과 대신 사용하지 않는다. GET만 기존30초/unmount 읽기 취소에 묶고 POST는 자동 중단·재실행하지 않는다. 읽기 오류와 변경 요청 오류도 분리했다.
- 변경 관련 화면4개가 통과한 뒤 새 effect 동기 상태 변경 lint 오류1개를 확인해 첫 조회를 취소 가능한 타이머로 연결했다. 최종 영향 화면4개(1.25초), 해당source2개 lint0, 프런트 타입/Vite build0(17.07초, index-DC1-9o3I.js)를 확인했다. 후보 선택/실행 UI·AI 지시·API 문서와 실제 내장 브라우저 검증은 후속이므로7.7은 아직 완료하지 않는다. 운영 설치·서비스 재시작·외부 배포는 하지 않았다.
- 7.5를 호스트 전용 target/context DB, 공통 resolver 통로, requestId durable journal, 정확한 startedRunId/done 및 binding별 status/cancel로 연결했다. CLI 명령과 op-only 동적 도구는 유지하고 CLI가 host contextId를 자동 동봉한다. token이나 수정 가능한 CLI를 사본/쓰기 중지 증거로 사용하지 않으며 기존 실제 독립 사본 검사 뒤에만 worker를 시작한다. 재시작 processing은 같은 요청의 interrupted와 알려진 runId/종료 미확인 정보를 보존하고 원래 browser 영수증을 수정하지 않는다. host evidence를 검증한 업무 imagePath 복제본도 유지한다.
- 신규 context 최초 검사는 실제3 RED/기존1 pass(2.89초)였고 첫 구현 뒤4/4가 통과했다(2.39초). build의 optional startedId 타입 오류1개는 실제 string 확인으로 수정해 컴파일을 통과했다. 리뷰에서 mailbox의 explicit success:false 덮어쓰기와65번째 이후 processing 미복구2개를 실제 RED(1.41초)로 확인했다. false 판정을 보존하고 파일별 처리 상태로 한 poll의64개 뒤 잔여를 이어 복구하도록 최소 보강했다.
- 최종 regressions5+기존mailbox4+actualcandidate1의10개가 통과했다(67.50초). user 후보 전환 뒤 옛 Work queued 거부, 실제 CLI의 같은 후보 사본/fresh/화면 복제본·host 원본, 기존 대화의 실제 Work CLI 실행을 확인했다. 별도 강화 restart1+이전turn/타업무/공유출력3의4개도 통과했다(2.41초). unchanged context의 exactrun/cancel/소유경계3은 앞선 근거를 재사용하며 최종 단일 전체17개 실행으로 표현하지 않는다. 최종 backend build와 diff 검사를 통과했고7.5만 완료하여40/54다. 전역 slot·사본점유/종료 복구7.6과UI7.7나머지는 후속이며 운영 설치/재시작/외부배포·실제 내장 브라우저 검증은 하지 않았다.
- 7.7 후속 후보 패널과 사용자 전용 HTTP 경로를 연결했다. 후보에서 시나리오는 업무 등록본을 읽고 같은cid의run과 정확runId의cancel만 요청한다. 실제 phase/state를 전달하고 문서/후보 초안 보호와 과거 후보 읽기 전용을 유지한다. HTTP 제어는 동결된 기존 엔진의 public 계약만 사용하며7.6 worker/slot/guard 파일은 수정하지 않았다. AI 지시와 API/사용 문서에 대상·환경·빌드·현재 판정·동일 실행 중단 계약을 추가했다.
- 후보 패널 신규2개를 실제 RED(943ms) 후 구현하여 Browser6+CandidateLifecycle10의16개가 통과했다(2.48초). source2개 lint0, 프런트 타입/Vite build0(18.54초, index-DJurb3qW.js)를 확인했다. 새 실제 Nest HTTP4개는3통과/빈Work중단body 호환1실패(1.08초)였고 Nest의{} 기본값을 기존Work경로에서만 허용해 해당1개가 통과했다(1.11초). 타입 build도 통과했다. 최신 backend 종료 엔진7.6의 결합 검증과 실제 내장 브라우저 조작은 아직 수행하지 않았으므로7.7 전체 완료 체크는 하지 않는다.