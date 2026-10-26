# OpenSpecBoard 데스크톱 앱

현재 웹 대시보드를 재사용하는 Windows x64 앱이다. 웹 개발 서버 13001~13003은 그대로 유지하며 앱은 별도 포트와 사용자 데이터로 실행한다.

## Windows 무설치 ZIP 다운로드

[v0.1.2 무설치 ZIP 다운로드](https://github.com/sklee385/open_spec_dashboard/releases/download/v0.1.2/OpenSpecBoard-0.1.2-win-x64-portable.zip)를 새 쓰기 가능한 폴더에 **전체 압축 해제**하고 안의 `OpenSpecBoard.exe`를 실행한다. 기존 앱은 창 닫기 대신 **앱 종료**로 정상 종료한다. 기존 앱이 트레이에 남아 있으면 같은 사용자 프로필의 이전 창이 다시 열릴 수 있다. ZIP 안에서 실행하거나 EXE만 복사하지 않는다. [무설치 사용 안내](PORTABLE.md)를 참고한다.

무설치판은 전용 ZIP을 확인·다운로드하고 사용자 재시작 요청과 업무 유휴 조건을 만족할 때 실행 폴더를 교체한다. 설치형 EXE로 전환하지 않는다. 데이터는 기존 `%APPDATA%/openspecboard`에 유지한다. 설치형 파일·latest.yml도 기존 설치형 사용자의 업데이트 호환을 위해 별도로 유지한다. 실제 GitHub Actions 실행 검증은 남아 있으며 사용자가 보고한 설치 문제의 원인을 확정한 것은 아니다.

## 지원 범위

| 대상 | 런타임 기준 최소 OS | 배포 형식 | 검증 상태 |
| --- | --- | --- | --- |
| Windows x64 | Windows 10 이상 | 사용자별 NSIS 설치 파일 | Windows 11 빌드·자동 검증 진행 |

Electron 45.0.0, electron-builder 26.18.0, electron-updater 6.8.11을 고정한다. 동봉 Node는 24.15.0이다. OS 하한은 [Electron 45 지원표](https://github.com/electron/electron/blob/v45.0.0/README.md#platform-support)와 [Node 24.15 지원표](https://github.com/nodejs/node/blob/v24.15.0/BUILDING.md#platform-list)의 교집합이다. 최소 OS에서 직접 실행한 검증 결과와 런타임의 지원표는 구분한다.

## 로컬 빌드와 실행

Windows에서는 프로젝트 전용 런타임을 사용한다.

```powershell
./scripts/npm.ps1 ci
./scripts/node.ps1 node_modules/electron/install.js
./scripts/npm.ps1 run build
./scripts/npm.ps1 run desktop:test
./scripts/npm.ps1 run desktop:stage
./scripts/npm.ps1 run desktop:dev
```

실행 폴더 생성은 `./scripts/npm.ps1 run desktop:pack`, 설치 파일 생성은 `./scripts/npm.ps1 run desktop:dist`다. 산출물은 `.tools/desktop-dist`에 생성하며 두 명령 모두 GitHub에 게시하지 않는다. 설치 파일 생성에는 NSIS 등 공식 빌드 보조 파일 다운로드가 필요하다.

`desktop:stage`는 기본적으로 `.tools/desktop-stage`만 재생성한다. 빌드한 화면·서버·잠금 파일의 배포 의존성과 실행 중인 Node 배포의 Node/npm을 복사한다. 실행 중인 Node 버전과 OS·아키텍처는 `service/build-info.json`에 기록한다. 스테이징과 패키징을 동시에 실행하지 않는다.

기본 실행 폴더가 사용 중이면 앱을 강제 종료하지 않고 분리 빌드한다. `DESKTOP_STAGE_NAME=desktop-stage-shutdown`을 스테이징·패키징 양쪽에 지정하고, 패키징에 `--config.directories.output=.tools/desktop-dist-shutdown`을 전달한다. 이름은 `desktop-stage` 또는 영문 소문자·숫자를 하이픈으로 덧붙인 형식만 허용하며 경로 구분자·상위 폴더 이동과 링크는 거절한다. 지정한 `.tools` 하위 스테이징 폴더만 재생성한다.

## 첫 실행과 저장 위치

새 프로필은 프로젝트가 없는 상태로 시작한다. 설정에서 기존 프로젝트의 `openspec` 경로를 등록한다. 기존 웹 환경의 DB·도구 설정은 자동으로 가져오지 않는다. 기존 프로젝트 원본과 웹 환경 `.data`는 변경하지 않는다. Codex·외부 AI CLI는 사용자의 설치와 인증을 이용한다.

앱 데이터는 Electron `userData` 아래에 둔다. 기본적으로 `%APPDATA%/openspecboard`다. 설치 파일과 별도로 `data/work.sqlite`, `config.json`, `logs/desktop.log`, `backups/<시각>/`를 유지한다. 진단 로그에는 인증 비밀과 CLI 원문 출력을 남기지 않는다.

창 닫기는 트레이로 숨긴다. 앱 메뉴나 트레이의 **앱 종료**로 정상 종료한다. 실행·연결·질문·승인·불확실한 업무 상태에서는 종료를 보류한다. 세션 서버가 이미 종료됐으면 창을 안전하게 종료하고 다시 실행할 수 있다.

미저장 문서가 있거나 화면의 닫기 허용 여부를 확인할 수 없으면 서버 종료 전에 보류한다. 문서를 저장한 뒤 종료·설치를 다시 요청한다. 화면 닫기 거절 뒤 서버만 먼저 종료되는 상태를 방지한다.

같은 데이터의 중복 세션은 OS가 소유하는 loopback 잠금 소켓으로 차단한다. 정규화된 데이터 경로의 해시로 30000~48999 중 한 포트를 사용한다. 다른 앱과 충돌해도 포트를 빼앗거나 두 번째 잠금으로 우회하지 않는다. 기존 소유자가 살아 있으면 오류를 확인하고 해당 업무가 중단되지 않도록 먼저 상태를 확인한다. API 게이트웨이와 세션 서비스 포트는 별도로 가용 포트에 bind한다.

## 질문·승인 알림 이동

앱에서 발행한 Windows 알림을 누르면 프로그램 안의 해당 업무·질문으로 이동한다. 실행 중이면 같은 창을 복원하고, 최소화·트레이 상태에서도 같은 창을 사용한다. 완전히 종료한 앱은 이미 받은 알림의 클릭으로 다시 실행한다. 앱과 소유 서버가 모두 종료된 동안에는 새 알림을 발행하지 않는다.

사용자 범위에 `openspecboard:` 프로토콜을 등록하고 기본 처리기 여부를 확인한다. 알림 링크는 `openspecboard://attention?workId=...&questionId=...`이며 내부 포트·인증 토큰·명령을 포함하지 않는다. 등록 실패 시 알림은 실제 비활성과 오류로 표시한다. 앱 전용 AUMID는 `OpenSpecBoard.DesktopNotifications`, 바로가기는 `OpenSpecBoard Desktop Notifications.lnk`다. 웹 알림 등록과 구분한다.

처음 실행할 때 최근 업무 복원보다 알림 링크를 먼저 처리한다. 실행 중에는 창을 새로고침하지 않고 기존 초안을 보존한 뒤 최신 업무·질문을 조회한다. 잘못된 링크·삭제된 대상·초안 저장 실패는 오류로 안내하며, 답변·승인·재연결·구현은 자동 실행하지 않는다. 연속 클릭은 순서대로 처리한다. 이전에 발행한 Edge 알림과 서버의 한 번 발행 기록은 자동 변경하거나 재발행하지 않는다.

## 업데이트

공개 저장소 `sklee385/open_spec_dashboard`의 정식 GitHub Releases를 앱 시작 시와 4시간마다 확인한다. 앱 메뉴의 **앱 업데이트**에서 현재·대상 버전, 다운로드 진행률, 오류 및 재시도를 확인한다. 새 파일을 다운로드해도 설치하지 않으며 사용자가 **업데이트하고 재시작**을 선택해야 한다.

확인 중에는 시작·주기·수동 요청이 겹쳐도 추가 조회를 하지 않는다. 오프라인·호출 제한·다운로드 오류 후에는 수동으로 재시도할 수 있다. 설치 전환 후 같은 요청이 다시 들어와도 종료·설치를 중복 실행하지 않는다.

정식 버전·태그와 `OpenSpecBoard-<버전>-win-x64.exe`를 다운로드 전에 확인한다. 호환 파일 부재·다른 아키텍처 혼입은 오류로 차단한다. 배포 전 검사에서는 정확한 버전의 EXE와 `latest.yml`의 해시를 확인하고 중복 메타데이터·다른 버전 파일이 있으면 게시를 차단한다.

설치 전 모든 업무와 처리 중 요청을 확인하고 신규 변경 요청을 차단한다. 업무가 남아 있으면 이유를 표시하고 설치를 보류한다. 정상 종료 시 읽기용 실시간 연결을 끊고 DB를 닫은 후 설정·데이터의 일관된 백업을 생성한다. 백업 실패나 종료 불확실 시 설치하지 않는다. 이전 버전 자동 설치와 종료 시 자동 업데이트도 사용하지 않는다.

앱 종료와 업데이트 설치는 같은 종료 준비 잠금을 사용한다. 다른 요청이 진행 중이면 새 요청은 보류하며, 소유 요청만 정상 종료·백업·잠금 취소를 수행한다. 준비 응답이 끊기면 서버 잠금 취소를 시도한다. 취소 응답도 확인할 수 없으면 업무 요청 차단을 유지하고 연결 확인 후 종료·설치의 명시적 재시도를 허용한다.

**개인용 배포는 인증서 없이 GitHub 업데이트를 사용한다.** 2026-10-26 사용자 결정에 따라 `--personal-update` 또는 CI의 `--release`로 만든 패키지만 활성화한다. 일반 `desktop:stage`와 개발 실행은 비활성화한다. 기존 앱에서 업데이트가 꺼져 있다면 개인용 설치 파일을 한 번 수동 설치한다. 이후 더 높은 버전을 지정 GitHub 저장소에 게시하면 앱에서 확인·다운로드할 수 있다.

개인용 빌드는 NSIS의 인증서 배포자 검증을 끄고, 지정 HTTPS GitHub 피드·정확한 파일/버전·SHA-512 다운로드 검증은 유지한다. 해시는 배포자를 인증하지 않으며 저장소와 GitHub 계정을 신뢰하는 방식이다. 현재 앱을 쓰는 중이면 해당 업무를 마치고 정상 종료한 뒤 설치 파일을 실행한다.

로컬 개인용 설치 파일은 다음과 같이 준비한다. 두 명령에 같은 스테이징 이름을 지정한다. 이 명령은 GitHub에 게시하지 않는다.

```powershell
$env:DESKTOP_STAGE_NAME='desktop-stage-personal'
./scripts/npm.ps1 run desktop:stage -- --personal-update
./scripts/npm.ps1 run desktop:dist -- --config.directories.output=.tools/desktop-dist-personal
```

## 개인용 GitHub Actions 배포

최초 v0.1.1은 아래 직접 게시 절차로 공개했다. Actions 실행 검증은 별도 남은 작업이며 최초 직접 게시를 막는 조건으로 두지 않는다.

`.github/workflows/desktop.yml`의 수동 실행은 업데이트가 활성화된 미서명 Windows x64 산출물을 만들고 게시하지 않는다. 버전 태그 `v<package.json 버전>` 실행은 지정 저장소·지원 대상·태그·GitHub 게시 토큰을 검증한 뒤 게시한다. 인증서와 `WIN_CSC_*` 비밀은 필요 없다.

게시에는 Actions가 제공하는 `GITHUB_TOKEN`을 `GH_TOKEN`으로 전달한다. 토큰은 앱·정책 JSON·로그에 넣지 않는다. GitHub 계정 설정 변경은 자동 수행하지 않는다.

Windows 빌드가 성공하면 버전·아키텍처·필수 파일·SHA-512를 검사하고, 같은 릴리스 초안에 파일을 모은 뒤 정식 게시한다. `desktop-release` 환경에는 저장소 운영자가 필요한 배포 검토 규칙을 설정할 수 있다. 사용자가 GitHub 배포를 명시적으로 요청한 뒤 배포 소스·버전·검증 결과를 확인하고 태그를 push한다. 게시 실패 시 초안만 남고 정식 피드에 노출하지 않는다.

게시 단계는 `desktop/publish.cjs`가 담당한다. 지정 저장소의 태그 push와 게시 토큰을 확인하고 EXE·EXE.blockmap·`latest.yml`을 검사한 뒤, 인증된 전체 릴리스 목록에 같은 태그가 없는 경우에만 새 초안을 만든다. 파일은 정해진 세 개만 올리며 `--clobber`를 사용하지 않는다. 이 옵션은 기존 파일을 먼저 삭제하므로 배포에 사용하지 않는다. [GitHub CLI 업로드 정책](https://cli.github.com/manual/gh_release_upload)

업로드 후에는 인증된 전체 페이지 목록에서 같은 태그의 초안이 정확히 하나인지 확인한다. 태그 조회 API는 게시된 릴리스용이므로 초안 검증에 사용하지 않는다. 원격 파일 이름·개수·크기·완료 상태·SHA-256과 로컬 재해시가 모두 일치할 때만 게시한다. GitHub가 digest를 제공하지 않아도 게시를 중단한다. [릴리스 목록 계약](https://docs.github.com/en/rest/releases/releases#list-releases), [파일 digest 계약](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)

운영 순서는 다음과 같다.

1. 앱 버전을 올리고 같은 버전 태그로 CI를 시작한다. 수동 workflow 실행은 개인용 산출물 생성만 수행한다.
2. Windows 빌드·파일 검사가 모두 성공한 뒤 release job에서 초안 생성·업로드·원격 검증·게시를 진행한다.
3. 조회·인증·업로드·검증이 실패하면 게시하지 않는다. 오류 원문이나 토큰을 출력하지 않고 실패 단계를 알린다. 생성한 초안과 기존 릴리스는 자동 삭제하지 않는다.
4. 실패 후 같은 태그의 초안이 남아 있으면 재실행도 덮어쓰지 않고 중단한다. 관리자가 실패한 미게시 초안임을 확인하고 명시적으로 정리한 뒤 재실행하거나 새 버전을 사용한다. 이미 게시된 버전은 교체하지 않고 새 버전으로 배포한다.

## 개인용 최초 직접 게시 운영 절차

직접 게시는 사용자가 선택한 최초 v0.1.1 배포 경로다. 정상 로그인한 GitHub CLI의 자격 증명 저장소를 사용하며 앱·소스·로그에 토큰을 넣지 않는다. CI 전용 `desktop/publish.cjs`를 쓰기 위해 이벤트나 CI 환경 값을 꾸미지 않는다.

1. 지정 저장소 `sklee385/open_spec_dashboard`의 태그 `v0.1.1`이 검증한 소스 `c129aaa8d617e694bc49872722a5f349be1b4944`를 가리키는지 확인한다. 로컬 EXE·EXE.blockmap·latest.yml 세 파일의 버전·SHA-512·SHA-256·개인용 정책과 기록된 검사 결과를 재확인한다.
2. 인증된 전체 릴리스 목록을 조회한다. 같은 태그의 릴리스나 초안이 있으면 중단한다. 새 초안은 `gh release create ... --verify-tag --draft`로 만들며 기존 태그를 이동하지 않는다.
3. 세 파일만 `gh release upload`로 업로드한다. `--clobber`는 쓰지 않는다. 업로드 뒤 같은 태그의 초안이 정확히 하나인지와 저장한 초안 ID를 확인하고, 원격 파일 이름·개수·크기·uploaded 상태·SHA-256 digest 및 로컬 재해시가 모두 일치하는지 확인한다.
4. 검증을 통과한 초안만 `gh release edit ... --draft=false --latest`로 공개한다. 실패하면 자동 삭제·덮어쓰기·재업로드를 하지 않고 초안과 원본을 보존한다. `gh api --paginate --slurp` 응답은 JSON으로 파싱하며 해당 옵션과 `--jq`를 함께 쓰지 않는다.
5. 공개 latest 릴리스의 버전·상태·파일을 확인하고 인증 없는 다운로드로 세 파일을 다시 받아 SHA-256·메타데이터 SHA-512와 플랫폼 선택을 검사한다. 릴리스 URL과 검증 결과를 기록한다. 이 검사는 설치 파일을 실행하거나 사용자 앱을 교체하지 않는다.

## 자동 검증과 복구

```powershell
./scripts/npm.ps1 run test:run --workspace backend
./scripts/npm.ps1 run test:run --workspace frontend
./scripts/npm.ps1 run desktop:test
./scripts/node.ps1 scripts/desktop-service-smoke.cjs
./scripts/node.ps1 scripts/desktop-service-smoke.cjs --packaged --isolated
./scripts/node.ps1 scripts/desktop-service-smoke.cjs --service-directory .tools/desktop-stage-lifecycle/service --isolated --busy-sessions --read-only-service
./scripts/node.ps1 scripts/desktop-service-smoke.cjs --service-directory .tools/desktop-dist-integration/win-unpacked/resources/service --isolated --busy-sessions --download-pipeline --update-backup-failure
./scripts/node.ps1 scripts/desktop-smoke.cjs
./scripts/node.ps1 scripts/desktop-smoke.cjs .tools/desktop-dist-security/win-unpacked/OpenSpecBoard.exe --copy-to-temp --security
./scripts/node.ps1 scripts/desktop-smoke.cjs .tools/desktop-dist-lifecycle/win-unpacked/OpenSpecBoard.exe --copy-to-temp --security --lifecycle
```

서비스 smoke는 스테이징 후 실행하며 동봉 Node, 빈 프로젝트, 프로젝트 등록, 열린 SSE의 정상 종료, 일관된 백업 및 같은 업무 복구를 검사한다. 앱 smoke는 패키징 후 실행하며 별도 임시 프로필만 사용한다. GUI 확인과 실제 GitHub 두 버전 업데이트를 이 검사로 대체하지 않는다.

`--security`는 실제 Electron의 두 창에서 sandbox·contextIsolation 활성화와 nodeIntegration 비활성화, 대시보드의 Node 전역 미노출, 업데이트 창 메인 프레임의 정상 IPC 응답을 추가로 요구한다. `desktop/test/security.test.cjs`의 잘못된 창·하위 프레임·URL·외부 탐색 거절 검사는 Electron API 대역으로 실행한다. 실제 외부 브라우저를 열거나 GUI를 조작하는 검사는 아니다. 앱 smoke는 빈 전용 프로필만 허용하고, 검사 실패 시에도 소유 서비스의 유휴 종료와 백업을 시도하며 실패 종료 코드를 유지한다.

`--lifecycle`은 검사 실행기의 `windowsHide`를 해제하고 실제 창의 닫기·숨김·비파괴·재표시와 서비스 연결 유지를 확인한다. 트레이 더블클릭 이벤트를 프로그램으로 전달하므로 OS 트레이를 직접 클릭하는 수동 검증을 대신하지 않는다. 창은 잠시 표시된 뒤 검사 앱만 정상 종료한다.

`--packaged --isolated`는 패키지의 서비스를 저장소 밖 임시 폴더로 복사하고, 해당 복사본의 Node만 PATH에 둔다. 상속된 Node 검색 경로도 제거하여 SQLite 초기화·OpenSpec 조회·정적 화면·API·SSE·중복 소유자 거절·종료 후 재시작을 검사한다. 기존 13001~13003 포트가 계속 열려 있는지도 확인한다. 이는 시스템 Node 미설치 새 Windows VM과 실제 설치·화면 조작 검증을 대신하지 않는다. 임시 프로필과 복사본은 검사 근거로 남긴다.

`--service-directory`는 검사할 서비스 경로를 지정한다. `--busy-sessions`는 새 프로필의 fixture 업무와 미답변 질문·승인으로 실제 서버와 UpdateManager의 설치 보류·유휴 종료를 검사한다. 다운로드 오류는 이벤트 주입이며 설치기는 대역이다. 실제 서명 검사나 앱 교체를 수행하지 않는다.

`--download-pipeline`은 `--busy-sessions`와 함께 사용한다. 실제 NsisUpdater의 다운로드·SHA-512 검사 경로를 loopback 피드와 Node HTTP 전송에 연결해 연결 단절·변조 차단·정상 재시도를 검사한다. 별도 프로필의 시작 실패와 복구, 설치 전 잠금 뒤 새 실행 요청 거절도 확인한다. `--update-backup-failure`를 추가하면 새 프로필의 백업 경로에만 장애를 만들어 설치 차단·원본 데이터 보존·동일 프로필 재시작·명시적 재시도를 확인한다. fixture 설치 파일은 실행하지 않으며 실제 GitHub 조회와 두 버전 간 앱 교체 검증을 대신하지 않는다.

`--read-only-service`는 `--isolated`와 함께 사용한다. 동봉 Node의 권한 모델과 상속한 `NODE_OPTIONS`로 서비스·OpenSpec CLI 자식의 쓰기를 새 프로필로 제한한다. 서비스와 별도 Node 자식에서 설치 경로 쓰기 거절을 먼저 확인한다. Windows ACL이나 새 Windows VM의 검증과는 구분한다. 두 smoke는 서버 시작 전 새 프로필의 알림을 비활성화하여 검사 중 Windows 알림 등록과 토스트를 막는다.

실행 환경이 설치 폴더의 AppContainer 접근 권한을 제한하면 Electron이 샌드박스 검사를 통과하지 못할 수 있다. 샌드박스를 끄거나 ACL을 변경하지 말고 일반 Windows 설치 환경에서 별도 검증한다. 사용자 지시에 따라 Edge 화면 검증은 수행하지 않는다. 실제 Windows 앱의 창·설치·트레이·업데이트는 별도로 검증한다.

업데이트 후 시작 실패 시 설치 전 백업을 보존한다. 모든 앱 소유 프로세스 종료를 확인한 뒤, 백업 DB 스키마와 이전 앱 버전이 호환되는지 확인하고 설정·데이터를 함께 복구한다. 실패한 설치 파일을 자동으로 다시 적용하지 않는다.
