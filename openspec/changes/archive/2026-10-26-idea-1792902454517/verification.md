# 구현 및 검증 기록

## 2026-10-26 v0.1.2 무설치 자동 업데이트 배포 완료

- 검증한 소스 커밋 `21d16eb6926c0e0fbfa37c036566f8c90c16ebf6`을 `release/windows-v0.1.2` 브랜치와 `v0.1.2` 태그로 게시했다. main과 기존 v0.1.1 태그·릴리스·파일은 변경하지 않았다. 소스 사본의 데스크톱 테스트도 142개 통과·실제 자식 종료 코드 0이었다(`.logs/portable-release-source-tests.log`·`.json`).
- 새 초안 ID `423843057`에 ZIP·portable.json과 기존 설치형 호환용 EXE·blockmap·latest.yml 다섯 파일을 올렸다. 초안 생성 직후 목록 조회에 아직 나타나지 않아 최초 명령이 검증 중단됐고, 새 전체 조회로 동일 제목·태그·빈 파일 목록의 단일 초안 ID를 확인해 로컬 영수증만 복구했다. 중복 생성·원격 파일 삭제·덮어쓰기를 하지 않았다. 다섯 파일의 이름·크기·업로드 완료 상태·GitHub SHA-256 digest와 로컬 재해시 일치를 확인한 뒤 공개했다.
- 정식 릴리스: https://github.com/sklee385/open_spec_dashboard/releases/tag/v0.1.2 . 기본 무설치 다운로드: https://github.com/sklee385/open_spec_dashboard/releases/download/v0.1.2/OpenSpecBoard-0.1.2-win-x64-portable.zip . ZIP은 271,228,453바이트, SHA-256 `fa131d339789cb67d12c99b27aa92e87161b96ed78dbc94a883303c8c97f8c16`이다. GitHub 최신 릴리스·draft=false·prerelease=false와 다섯 파일을 확인했다.
- 실제 `PortableUpdater`를 새 `.tools/portable-public-validation-p24ELj`에서 현재 버전 0.1.1로 검사해 인증 없이 공개 GitHub API→portable.json→실제 ZIP 다운로드→SHA-512·SHA-256 검증까지 통과했다. 이어 현재 버전 0.1.2 검사에서는 새 버전 없음으로 판정했다. 다운로드한 설치 파일을 실행하지 않았고 실제 사용자 앱은 변경하지 않았다. 실행기 `.logs/test-portable-public.cjs`, 결과 `.logs/portable-public-verification.log`·`.json`, 종료 코드 0.
- 게시 실행기 `.logs/manual-portable-release.cjs`와 파일 고정 목록 `.logs/portable-release-plan.json`, 초안/공개 확인 `.logs/portable-release-verified-draft.json`·`portable-release-published.json`에 근거가 있다. 인증된 정상 CLI 로그인만 사용했고 CI 이벤트를 가장하지 않았다. `docs/DESKTOP.md`와 ZIP 안의 무설치 안내에 전체 압축 해제·기존 앱 정상 종료·자동 ZIP 업데이트·사용자 데이터/백업 위치를 기록했다.
- 7.5를 완료하여 무설치 추가 범위 7.1~7.5를 마쳤다. 전체 추적 진행률은 21/29이며 기존 Windows 별도 환경·실제 Actions·추가 사용자 UI/업무 확인 등 미완료 항목은 유지한다. 실제 사용자 설치/교체나 사용자 최종 확인을 대신하지 않는다.

## 2026-10-26 무설치 ZIP과 자동 업데이트 구현·검증

- 사용자가 설치형 EXE 사용이 정상적이지 않은 느낌이라고 보고해 무설치 배포를 요청했다. 문답에서 무설치 상태를 유지하는 자동 업데이트 개발을 명시적으로 선택했다. 설치 문제의 원인은 확정하지 않았다. 설치기 없이 ZIP 전체를 풀어 실행하는 v0.1.2와 전용 업데이트 경로를 구현했다.
- `portable-updater.cjs`는 고정 GitHub 정식 높은 버전과 portable.json·정확한 Windows x64 ZIP·크기·SHA-512만 사용한다. JSON 응답 크기·다운로드 크기·시간·리다이렉트 호스트를 제한하고 검증 실패 시 재시도를 허용한다. 설치형 EXE로 전환하지 않는다. 정책·실제 main 분기·기존 설치형 경로·준비 실패와 비동기 handoff를 테스트했다.
- `portable-install.cjs`는 스트림 해시·EOCD/ZIP64·중앙 디렉터리 사전 범위/개수·경로·링크·Windows 중복 경로·추출 실제 크기·64KiB 빌드 메타데이터 상한·정확한 버전/모드를 확인한다. 같은 볼륨의 새 옆 폴더에 준비하고 데이터 밖 보조 작업 디렉터리에 동봉 Node와 표준 라이브러리 전용 교체 스크립트를 복사한다.
- `portable-swap.cjs`는 준비 응답과 원래 앱 종료를 확인한 뒤 폴더를 교체한다. 기존 폴더 백업을 유지하고, 새 앱과 세션 상태가 불명확하면 강제 재실행하지 않는다. 새 앱 시작 후 확인된 실패는 폴더만 복구하고 DB 호환성 확인 없이 이전 앱을 자동 실행하지 않는다. 독립 검토에서 지적된 고아 세션·DB 하위 호환·ZIP 파서 선택 차이·대형 JSON 메모리 문제를 회귀 테스트로 확인하고 수정했다.
- 데스크톱 테스트 142개가 통과했다(`.logs/portable-all-desktop-tests-final.log`). 신규 실패 테스트→수정→통과 이력은 portable-integration-red/green.log·portable-release-red/green.log·portable-metadata-red.log 및 개별 테스트에 있다. 신규 의존성은 기존 unzipper 0.12.5를 런타임 의존성으로 고정했고 npm 검사 취약점 0개였다.
- 동결한 v0.1.1 소스 사본의 프런트·백엔드 빌드를 유지하고 데스크톱·정책·의존성·패키징 변경만 동기화해 v0.1.2 설치형과 무설치 ZIP을 별도 출력했다. `.logs/portable-installer-dist-final.json`과 `portable-zip-build-verified.json`의 실제 자식 종료 코드 0을 확인했다. 최종 ZIP은 27,176개 항목·비압축 합계 780,931,445바이트이며 사용자 DB/설정·인증 파일·debug.log 경로는 없고 무설치 안내 파일이 포함됐다.
- 실제 무설치 EXE를 TEMP 복사본과 새 프로필 `.tools/desktop-smoke-검증 공간-g5FBno`에서 실행해 렌더러 격리·업데이트 IPC·활성·닫기/숨김/재표시 콜백·정상 종료·백업을 확인했다(`.logs/portable-native-smoke.log`).
- 실제 Windows 폴더 교체 검사는 `%TEMP%/OpenSpecBoard-portable-live-e0hAqO`에만 수행했다. 0.1.1 폴더 복사본과 실제 이전 백엔드·테스트 업무 두 개를 만들고 Node 검사 부모에서 UpdateManager→실제 유휴 API→ZIP 다운로드/해시/추출→서버 정상 종료/백업→별도 보조 프로세스→폴더 교체→실제 0.1.2 Electron smoke 실행과 정상 종료를 확인했다. 다운로드 전송만 로컬 파일 Response로 대체했으며 원래 앱 부모는 Electron 대신 소유 Node 검사 프로세스였다.
- 질문 대기 중 설치 보류·서비스 유지, 유휴 후 새 POST 거절 503, 보조 프로세스 준비 응답 뒤 검사 부모 종료를 확인했다. job `6f6543d4b1888c62317a88b92db9e1c0`은 complete였고 새 앱 PID 44016의 시작 확인과 종료를 확인했다. 기존 폴더 백업, 업무·대화 ID·질문 답변·이벤트·설정·프로젝트 문서·표식 파일 보존과 종료 백업 두 개를 확인했다. 근거 `.logs/test-portable-live.cjs`·`test-portable-live-child.cjs`, `.logs/portable-live-verification.log`, QA 루트 verification.json과 job journal.json. 포트 리스너 스냅샷은 전후 모두 빈 목록이므로 실행 중 13001~13003 서버 공존의 신규 검증으로 확대하지 않는다.
- 실제 사용자 앱·프로필·프로젝트·서버는 교체하거나 종료하지 않았다. 7.1~7.4를 완료했으며 실제 GitHub 다운로드 확인·v0.1.2 게시인 7.5와 기존 미완료 범위는 별도로 남긴다.

## 2026-10-26 v0.1.1 직접 게시 완료

- 사용자가 계획 단계에서 “검증된 설치 파일을 직접 게시 하는 방식으로 진행”을 선택했고 문서 반영 후 “이제 진행 해”라고 실행을 지시했다. 이 최신 지시는 승인한 최초 직접 게시 범위로 해석하여 수행했다. 제품 코드 추가 구현·기존 사용자 앱 교체·세션 서버 재시작은 수행하지 않았다.
- 지정 저장소·태그 소스 `c129aaa8d617e694bc49872722a5f349be1b4944`·로컬 세 파일의 크기/해시·개인용 정책·버전을 다시 확인하고 인증된 전체 릴리스 목록에서 동명 릴리스가 없음을 확인했다. 공식 GitHub CLI의 keyring 로그인을 사용했으며 CI 환경 값을 꾸미거나 토큰을 앱·소스·로그에 넣지 않았다.
- 새 초안 ID `423750879`에 `OpenSpecBoard-0.1.1-win-x64.exe`·같은 이름의 `.exe.blockmap`·`latest.yml` 세 파일만 업로드했다. 원격 파일 이름·개수·크기·uploaded 상태·GitHub SHA-256 digest와 로컬 재해시를 확인한 뒤 초안을 정식 공개했다. 기존 파일·태그를 덮어쓰거나 이동하지 않았다.
- 정식 릴리스: https://github.com/sklee385/open_spec_dashboard/releases/tag/v0.1.1 . 공개 API에서 draft=false·prerelease=false·latest의 ID/버전/세 파일 일치를 확인했다. 직접 다운로드: https://github.com/sklee385/open_spec_dashboard/releases/download/v0.1.1/OpenSpecBoard-0.1.1-win-x64.exe . 설치 파일은 214,715,012바이트, SHA-256 `ae5dfc70d5d4bb88b6107971ae820e6efca867f22b936c5b64198087cd26bedd`.
- 세 파일을 인증 없이 `.tools/desktop-published-v0.1.1-check`로 다시 다운로드했다. 원래 고정된 SHA-256·크기와 메타데이터 SHA-512, 공개 태그와 메타데이터를 합친 Windows x64 파일 선택 검사를 통과했다. 설치 파일은 실행하지 않았다. 공개 다운로드 검사를 앱 내부의 실제 두 버전 간 설치·데이터 보존 검증으로 확대하지 않는다.
- 실행기 `.logs/manual-desktop-release.cjs`의 preflight/create/upload/publish 각 단계 종료 코드 0을 확인했다. 근거 `.logs/desktop-manual-release-receipt.json`, `desktop-manual-release-verified-draft.json`, `desktop-manual-release-published.json`, `desktop-manual-release-public-verification.json`. 공개 파일 재검사 `.logs/verify-published-release.cjs`도 종료 코드 0. 운영 절차와 다운로드 링크는 `docs/DESKTOP.md`에 기록했다.
- 작업 5.4를 완료했다. 총 24개 중 16개 완료이며 5.1 실제 Actions 실행, 실제 두 버전 간 설치와 사용자 최종 결과 검토는 남아 있다. 아래의 미게시·선택 대기·15/23 기록은 당시의 이력이다.

## 2026-10-26 GitHub 배포 요청 및 준비

- 사용자가 “github 배포 진행 해”라고 명시적으로 요청했다. 이전 기록의 원격 게시 미수행은 당시 결과이며 이번 배포를 금지하는 조건이 아니다.
- 기존 작업 브랜치·인덱스·실행 앱·13001~13003 서버를 보존하고 `.tools/desktop-release-v0.1.0`에 독립 배포 사본을 만들었다. 현재 대시보드의 프런트·백엔드와 패키징에 필요한 모듈·확장 파일·테스트 fixture를 포함하고 다른 업무의 계획 문서 변경은 포함하지 않았다. 사용자 DB·설정·로그·인증 정보·동봉 런타임은 소스 커밋에 넣지 않았다. 파일 목록은 `.logs/desktop-release-manifest.json`에 있다.
- 현재 설치본 0.1.0보다 높은 0.1.1을 배포 버전으로 준비했다. 배포 브랜치 `release/windows-v0.1.1`, 커밋 `c129aaa8d617e694bc49872722a5f349be1b4944`, 로컬 태그 `v0.1.1`이다. 원격의 같은 브랜치·태그가 없는 것을 조회했다. 아직 원격 push·Actions 실행·릴리스 게시 완료로 기록하지 않는다.
- 새 사본에서 `npm ci --ignore-scripts`가 통과했다(취약점 0개). 예제 문서 누락으로 첫 프런트 검사가 실패해 테스트가 참조하는 문서를 배포 사본에 포함한 뒤 재검사했다. 데스크톱 72개, 프런트 224개, 백엔드 243개 통과·2개 건너뜀과 프런트/백엔드 빌드 종료 코드 0을 확인했다. 로그 `desktop-release-desktop-tests-v011.log`, `desktop-release-frontend-tests.log`, `desktop-release-backend-tests.log`·`.json`, `desktop-release-build-verified.log`·`.json`.
- 제한된 실행 환경의 첫 백엔드 검사가 진행되지 않아 소유한 검사 프로세스 두 개만 종료하고, 확장 실행 권한과 상세 로그로 재실행했다. 실제 백엔드 검사는 271.42초에 통과했다. 빌드 결과는 PowerShell stderr 표시와 구분하여 자식 종료 코드를 JSON으로 별도 확인했다. 인증서·API 키 패턴 검사에서 배포 사본 파일의 해당 패턴을 찾지 못했다.
- 공식 GitHub CLI를 `.tools/github-cli`에 준비하고 사용자가 기기 로그인을 승인해 `sklee385` 계정의 정상 keyring 로그인을 확인했다. 사용자가 추가 기기 인증 완료를 알린 뒤 repo·workflow 권한을 확인했다. 인증 정보는 앱·소스·검증 로그에 기록하지 않는다.
- 같은 커밋의 소스로 v0.1.1 Windows x64 설치 파일을 생성했다. 위치 `.tools/desktop-release-v0.1.0/.tools/desktop-dist/OpenSpecBoard-0.1.1-win-x64.exe`, 크기 214,715,012바이트, SHA-256 `ae5dfc70d5d4bb88b6107971ae820e6efca867f22b936c5b64198087cd26bedd`. `desktop/artifacts.cjs`의 버전·파일·SHA-512 검사와 실제 app.asar의 정책·최신 데스크톱 소스·고정 피드 검사가 통과했다. 이 파일은 아직 GitHub에서 빌드·게시한 산출물이 아니다.
- 새 v0.1.1 EXE의 `--copy-to-temp --security --lifecycle --personal-update` 검사도 종료 코드 0으로 통과했다. 빈 검사 프로필 `.tools/desktop-smoke-검증 공간-h9QGIc`에서 격리·업데이트 IPC·개인용 활성·정상 종료와 백업을 확인했다. 로그 `.logs/desktop-release-native-v011.log`. 기존 사용자 앱은 설치·교체·종료하지 않았다.
- 인증 후 `release/windows-v0.1.1` 브랜치와 `v0.1.1` 태그를 한 번의 atomic push로 게시했다. 원격 태그 객체 `1f8f5805082d1d37f3bd3f8fbf43bf971da0d859`의 대상이 검증한 커밋 `c129aaa8d617e694bc49872722a5f349be1b4944`임을 API로 확인했다. main·기존 태그·사용자 작업 브랜치는 변경하지 않았다.
- GitHub Actions 활성 설정은 enabled/all이지만 workflows·workflow_runs 목록은 0개이고 워크플로 이름 조회는 404였다. 태그의 workflow 파일은 API에서 확인했다. 독립 리뷰의 YAML 파싱 오류는 없고 v* 패턴·태그·커밋에도 실행 생략 지시가 없다. 공식 문서상 push 실행에는 기본 브랜치 workflow가 필수라는 조건이 없으므로 main 부재를 확정 원인으로 기록하지 않는다. 수동 workflow_dispatch는 기본 브랜치 등록이 필요하며, 현재 설정의 수동 실행은 게시 job을 실행하지 않는다. 실제 CI 실행과 릴리스는 아직 없다.
- 5.1의 음성검사를 위해 로컬 `v-ci-mismatch-1792902454517` 태그를 만들었으나 원격 push는 자동 승인 심사에서 거부됐다. 이유는 v0.1.1 배포 외의 부수적 원격 변경 승인 부족이며 더 안전한 로컬 검증 대안이 있다는 것이었다. 원격 음성검사 태그를 만들지 않았고 다른 수단으로 우회하지 않았다. 이 검사 실패를 정상 게시나 5.1 완료로 처리하지 않는다.
- 사용자에게 이미 검증한 v0.1.1 파일의 개인용 수동 최초 게시와 기존 CI 경로 유지 중 선택을 요청한다. CI 전용 게시 계약을 사용자 결정 없이 완화하거나 환경 값을 속여 기존 게시 함수를 실행하지 않는다. source 태그·앱 소스·파일·버전·해시 검증 자료는 준비됐다.

## 2026-10-26 실패·복구 통합 검증

- 자동 다운로드 Promise가 실패해도 확인 요청에서 처리하지 않던 문제를 회귀 테스트로 재현한 뒤 `desktop/updates.cjs`에서 처리했다. 이미 수신한 updater 오류 메시지는 보존하고, 실패 후 다시 확인할 수 있다. 데스크톱 테스트 72개가 통과했다(`.logs/desktop-integration-tests.log`).
- `scripts/desktop-download-fixture.cjs`는 실제 NsisUpdater·ElectronHttpExecutor의 메타데이터 선택·다운로드·SHA-512 검증 경로를 사용한다. loopback 피드와 Node HTTP 전송만 대체하고 설치기는 실행하지 않는다. `desktop-service-smoke.cjs --isolated --busy-sessions --download-pipeline`에서 연결 단절·변조 파일 차단·정상 재시도, 다른 업무의 실행·연결·질문·승인 대기, 유휴 전환 후 설치 잠금과 새 실행 요청 거절을 확인했다.
- 실제 별도 서버에서 DATA_DIR 시작 실패·원본 파일 보존·같은 경로 복구를 확인했다(`scripts/desktop-startup-fixture.cjs`). 실제 종료·SQLite 백업·SSE 종료·재실행·백업 복원 후 업무·대화 식별자 보존도 통과했다. 결과 `.logs/desktop-download-integration-final.log`, 프로필 `%TEMP%/OpenSpecBoard-service-검증 공간-YLszle/profile`, 종료 코드 0.
- `--update-backup-failure` 실행에서는 새 검사 프로필의 백업 경로에 파일을 만들어 실제 백업을 실패시켰다. 설치 호출 0회·원본 DB 보존을 확인하고, 해당 장애 파일만 제거한 뒤 같은 프로필로 명시적으로 재시작해 업무·대화를 확인했다. 다시 설치를 요청하면 정상 종료와 백업 후 설치 대역을 호출했다. 결과 `.logs/desktop-download-backup-failure.log`, 프로필 `%TEMP%/OpenSpecBoard-service-검증 공간-Ok8Iao/profile`, 종료 코드 0.
- 두 실행 모두 기존 13001~13003 포트는 검사 전후 열려 있었고 기존 앱과 세션 서버는 종료하지 않았다. 독립 읽기 전용 리뷰에서도 추가 중요 회귀나 기존 프로세스 간섭 문제를 찾지 못했다. 실제 GitHub 두 버전 다운로드·설치와 새 Windows VM 검증은 별도로 남긴다.
- GitHub 연결 도구로 지정 저장소의 릴리스 목록을 조회한 결과 빈 목록이었다. 현재 공개된 설치 파일·업데이트 릴리스가 있다고 안내하지 않는다. 원격 게시·태그 push는 수행하지 않았다.
- 다운로드 오류 처리 수정을 포함해 `desktop-stage-integration`을 `--personal-update`로 준비하고 `desktop-dist-integration`에 NSIS 설치 파일을 다시 생성했다. 파일·메타데이터·SHA-512 검사와 실제 app.asar의 최신 소스·정책 일치 검사를 통과했다. 로그 `.logs/desktop-integration-stage.log`·`desktop-integration-dist.log`.
- 새 패키지를 `--copy-to-temp --security --lifecycle --personal-update`로 실행해 실제 렌더러 격리·업데이트 IPC·개인용 활성 정책·창 닫기/숨김/재표시 콜백·정상 종료와 백업을 확인했다. 프로필 `.tools/desktop-smoke-검증 공간-Q9OvRe`, 로그 `.logs/desktop-integration-native.log`, 종료 코드 0. 실제 사용자 앱은 교체하지 않았다.
- 작업 6.3을 완료로 반영했고 OpenSpec apply 조회에서도 해당 항목 완료와 15/23 진행률을 확인했다. 실제 설치기를 실행하지 않은 통합 검사이므로 4.4·6.2·6.4의 전체 완료로 확대하지 않는다. GitHub Actions 실행 목록도 0개였으며 5.1의 원격 실행은 미확인이다.

## 2026-10-26 인증서 없는 개인용 GitHub 업데이트

- 사용자가 혼자 사용하는 앱으로 인증서 없이 GitHub에서 업데이트할 수 있는지 요청했고, 서명 검증을 제외하되 지정 저장소·파일 해시·사용자 설치 요청·업무 유휴 조건을 유지하는 설명에 “알았어 진행 해”라고 승인했다. 제안서·설계·업데이트 명세·작업 목록을 이 결정으로 맞췄다. 아래의 과거 서명 필수·인증서 부재 기록은 이전 정책의 이력이며 더 이상 완료 조건이 아니다.
- `desktop/update-policy.cjs`로 개인용 모드·고정 저장소·엄격한 활성 bool·패키지 실행을 모두 확인한다. `--personal-update`와 CI의 `--release`만 업데이트를 활성화하며 일반 검사·개발 실행과 알 수 없는/이전 정책은 비활성화한다. main의 GitHub 피드는 `sklee385/open_spec_dashboard`로 고정한다.
- NSIS 인증서 배포자 검증과 인증서 필수 조건을 제거했다. GitHub HTTPS 피드·정확한 단일 Windows x64 파일·버전/태그·정규 base64 SHA-512를 요구한다. 게시 시 EXE·blockmap·latest.yml의 SHA-512/SHA-256 및 덮어쓰기 방지는 유지한다. 해시는 저장소나 계정 침해에 대한 배포자 인증으로 취급하지 않는다.
- GitHub Actions는 인증서 비밀 대신 기본 `GITHUB_TOKEN`을 `GH_TOKEN`으로 연결한다. 저장소·태그·지원 대상·게시 토큰 누락은 계속 실패한다. 수동 workflow는 개인용 산출물을 만들고, 태그 workflow만 초안 검증 후 게시한다. 실제 원격 Actions 실행·태그 push·릴리스 게시를 수행한 것은 아니다.
- 데스크톱 테스트 71개가 통과했다(`.logs/desktop-personal-tests.log`). 실제 `NsisUpdater.downloadUpdate()`와 `ElectronHttpExecutor`의 다운로드·해시 파이프라인에서 loopback Node HTTP 전송만 대체했다. 정상 미서명 fixture는 ready가 되고, 변조 bytes는 `ERR_CHECKSUM_MISMATCH`·설치 경로 없음·manager error로 차단됐다. fixture 설치기는 실행하지 않았다. 정책·CI 연결·잘못된 SHA-512·개인용 main IPC 및 음성 smoke 조건을 검증했고 독립 리뷰에서 추가 중요 회귀는 발견되지 않았다.
- 프런트·백엔드 빌드가 실제 자식 종료 코드 0으로 통과했다(`.logs/desktop-personal-build-result.json`, `desktop-personal-build-stdout.log`, `desktop-personal-build-stderr.log`). 프런트 청크 크기 경고는 남아 있다. 13003 세션 서버는 재시작하지 않았다.
- `DESKTOP_STAGE_NAME=desktop-stage-personal`과 `desktop:stage -- --personal-update`로 준비하고 `.tools/desktop-dist-personal`에 새 NSIS 설치 파일을 생성했다. 로그 `.logs/desktop-personal-stage.log`·`.logs/desktop-personal-dist.log`, 파일 검사 `desktop/artifacts.cjs` 통과. `.logs/desktop-personal-package-check.cjs`는 실제 app.asar의 정책·원본 소스 일치, 고정 피드·publisherName 부재·개인용 빌드 정보·메타데이터의 토큰/인증서 키 부재를 확인했다.
- 새 EXE를 `--copy-to-temp --security --lifecycle --personal-update`로 실행해 실제 업데이트 창 IPC의 idle·개인용 정책 활성, 렌더러 격리·빈 프로젝트·창 수명·정상 종료·백업·exit 0을 확인했다. 프로필 `.tools/desktop-smoke-검증 공간-mm7WmJ`, 로그 `.logs/desktop-personal-smoke.log`. smoke는 GitHub 조회와 실제 설치를 실행하지 않으므로 두 버전 간 업데이트 검증을 대신하지 않는다.
- 작업 4.3·5.2를 완료했다. 현재 앱의 비활성 정책은 실행 중인 프로세스에 자동 반영되지 않으므로 새 개인용 설치 파일을 한 번 수동 설치해야 한다. 실제 GitHub 다운로드·재시작 설치와 데이터 보존은 6.2에 남긴다.

## 2026-10-26 사용자 트레이 동작 확인

- 사용자는 안내한 창 닫기 후 Windows 알림 영역에서 OpenSpecBoard 아이콘을 더블클릭해 창을 다시 여는 동작에 대해 “되는거 확인”이라고 답했다. 사용자 보고에 따른 OS 트레이 재열기 확인으로 기록한다.
- 설치·재설치, 트레이 우클릭 메뉴, 서명된 두 버전 사이의 실제 업데이트까지 확인한 것으로 확대하지 않는다. 6.4 전체 완료나 사용자 최종 결과 확인을 대신하지 않는다.

## 2026-10-25 화면 검증 인계 후 재개

- 기존 대화의 승인 이력과 마지막 중단 내용을 확인하고 이 대화에서 검증을 이어받았다. `@oai/sky`로 기존 OpenSpecBoard 창을 관찰한 뒤 입력마다 다시 관찰하는 방식으로 메뉴 클릭과 업데이트 창 열기·닫기를 실제 수행했다. 이번 검증에서는 사용자 입력 감지로 조작이 보류되지 않았다. 이전의 반복 보류 원인이 영구적으로 수정됐다고 단정하지 않는다.
- 기존 앱의 **OpenSpecBoard → 앱 업데이트**에서 개발·미서명 빌드의 자동 업데이트 비활성 안내와 비활성 버튼을 확인했다. 업데이트 창을 닫은 뒤 기존 업무와 작성 중인 대화 초안이 유지됨을 화면에서 확인했다. 기존 앱·업무·세션 서버는 종료하거나 재시작하지 않았다.
- `.logs/desktop-ui-qa`의 검사 실행기를 사용했다. 검사 창에 `격리 화면 검증` 제목을 붙여 기존 창과 구분하고 `.tools/desktop-ui-qa-pDCzyP`에 새 프로필을 만들었다. 알림은 비활성화했고 프로젝트·업무가 모두 0개임을 SQLite와 설정 파일로 확인했다. 사용한 앱 코드는 `.tools/desktop-stage-lifecycle/desktop/main.cjs`다.
- 제한된 실행 환경의 최초 검사 앱은 `0x80000003` 오류로 기동하지 못했다. 오류 창을 확인·닫고, 승인된 확장 실행 권한으로 같은 검사 실행기를 실행하자 기동했다. 이 결과를 제품 코드 수정으로 설명하지 않는다.
- 검사 앱의 프로젝트 미등록 첫 화면, **소스 설정**의 빈 소스 목록·AI 도구 안내를 실제 확인하고 설정 변경 없이 닫았다.
- 검사 창의 닫기 버튼을 눌러 창이 창 목록에서 사라지는 것을 확인했다. 소유 프로세스 PID `510164`는 유지됐고 로그에 `window-close allowed=false`가 기록됐다. 같은 검사 프로필의 두 번째 실행은 종료되고 원래 창 ID `14618348`과 프로세스가 복원됨을 확인했다. 이는 닫기 후 숨김과 두 번째 실행에 의한 복원 검증이며, Windows 알림 영역 아이콘 직접 클릭 검증은 아니다.
- 검사 앱의 **OpenSpecBoard → 앱 종료**를 실제 선택했다. 검사 프로세스 종료와 로그의 `normal shutdown and backup completed`, `will-quit`, `quit`를 확인했다. `backups/2026-10-25T14-39-57-763Z/`에 설정·알림 설정·SQLite 백업이 생성됐다. 검사 프로필과 백업은 보존했다.
- 남은 범위: Windows 알림 영역 아이콘 직접 클릭·메뉴, 설치본의 설치·재설치, 서명된 두 버전 사이의 실제 업데이트. 이번 부분 검증만으로 작업 6.4 전체나 사용자 최종 결과 검토를 완료 처리하지 않는다.

## 2026-10-25 인계 결과 확인 및 읽기 전용 경로 검증

- 인계된 `.tools/desktop-ui-qa-pDCzyP/logs/desktop.log`의 정상 종료·백업·will-quit·quit와 `backups/2026-10-25T14-39-57-763Z/`의 설정·데이터 백업을 확인했다. 인계 기록은 실제 GUI 부분 검증 근거로 유지하고, 이전 입력 보류를 현재의 접근 승인 부족으로 취급하지 않는다.
- 작업 2.2의 남은 읽기 전용 설치 경로 조건을 검사했다. 최신 `win-unpacked` 전체를 저장소 밖 `%TEMP%/OpenSpecBoard-readonly-c08a918132d5456889721458c1c8d953/app`에 복사하고, 이 새 복사본에만 현재 사용자 쓰기 거절 ACL을 상속 적용했다. 새 파일 생성과 기존 fixture 파일 덮어쓰기 모두 Windows에서 거절됐고 기존 내용은 유지됐다. 시스템·원본 설치·프로젝트·샌드박스 권한은 변경하지 않았다.
- 쓰기 거절 상태의 실제 EXE로 `--security --lifecycle` 검사를 수행했다. 별도 사용자 프로필 `.tools/desktop-smoke-검증 공간-MXe7OD`에서 빈 프로젝트·인증 API·렌더러 격리·IPC·창 닫기/숨김/재표시 콜백·정상 종료·로그·설정·SQLite·백업 생성 및 exit 0을 확인했다. 백업은 `backups/2026-10-25T14-45-01-936Z/`에 있다.
- 같은 읽기 전용 복사본의 동봉 Node·백엔드·OpenSpec CLI로 서비스 검사를 수행했다. `.tools/desktop-service-검증 공간-2FwFmq`에서 프로젝트 등록·fixture 업무/대화 식별자·다른 업무 상태에 따른 설치 보류·SSE 종료·재실행·백업 복원을 통과했다. 설치기는 대역이며 실제 AI 계정이나 서명 업데이트를 실행하지 않았다. 기존 13001~13003 포트는 검사 전후 모두 연결 가능했다.
- 실행기 `.logs/desktop-readonly-qa.ps1`, 로그 `.logs/desktop-readonly-qa.log`, 결과 `.logs/desktop-readonly-result.json`에 근거를 기록했다. finally에서 검사 복사본의 ACL을 원복했고 저장한 원래 SDDL과 실제 SDDL이 일치함을 별도로 확인했다. 검사 복사본·프로필·백업은 보존했다.
- 작업 2.2를 완료로 반영했다. 새 Windows VM의 실제 설치나 NSIS 재설치 검증은 아니므로 1.2·6.1·6.4는 완료 처리하지 않는다. 이 PC에 `WindowsSandbox.exe`가 없고 `sky.list_windows`/`list_apps`에서 알림 영역·작업 표시줄을 직접 조작할 대상도 찾지 못했다. 설치·OS 트레이 직접 조작·서명 업데이트는 남은 범위다.

## 사용자 설치 확인

- 사용자가 “지금 이거 설치 해서 하는 중인데 제대로 동작 한다.”고 보고했다. Windows 앱 설치 후 실행·사용이 정상 동작한다는 사용자 확인으로 기록한다.
- 이 답변만으로 트레이·창 다시 열기·업무 대기 중 종료 보호·서명 업데이트까지 확인한 것으로 확장하지 않는다. 해당 작업과 최종 완료 확인은 기존 상태로 유지한다.

## 최신 범위 변경

- 사용자는 macOS 삭제와 Edge 화면 검증 제외를 명시했다. 현재 대상은 Windows x64이며 두 항목을 남은 검증 요건으로 취급하지 않는다.
- 제안서·설계·두 명세·작업 목록 수정 후 구현을 이어서 macOS 패키징·업데이트·릴리스 검사·CI 지원과 공증 설정을 제거하고 운영 문서를 Windows 전용으로 맞췄다. macOS 정상 지원 테스트는 제거하고 지원하지 않는 플랫폼의 거절 테스트는 유지했다.
- 아래의 macOS 관련 과거 테스트 내용은 범위 변경 전의 실행 이력이며 현재의 지원·검증 요건이 아니다.

## 범위와 사용자 결정

- 사용자의 최신 문서 검토와 명시적 구현 시작 지시에 따라 구현했다. 결과에 대한 사용자 검토·완료 확인은 아직 받지 않았다.
- 대상: 현재 OpenSpecBoard, Windows x64, 공개 GitHub 저장소 `sklee385/open_spec_dashboard`.
- 추가 질문 응답: 서명 자격 증명은 아직 없음. 최소 OS는 선택 런타임 기준으로 정함.
- Electron 45.0.0 + 동봉 Node 24.15.0의 지원표 기준 Windows 10 이상 x64다. 실제 최소 OS 검증은 별도다.

## 구현 내용

- Electron 창·단일 인스턴스·Windows 트레이·업데이트 전용 화면, 최소 preload IPC와 외부 탐색 제한.
- 별도 Node 세션 서버와 정적 프런트/API 게이트웨이. 앱별 비밀 인증, 가용 서비스 포트와 데이터별 배타 소유 잠금. 기존 13001~13003 서버를 종료하거나 재시작하지 않았다.
- 사용자 데이터·설정·로그·백업을 설치 리소스와 분리. 처음에는 프로젝트가 없으며 기존 웹 DB는 자동 이전하지 않는다.
- 업데이트 자동 확인·다운로드, 사용자 요청 후 전체 업무 유휴 판정과 설치 잠금, 신규 요청 차단, 정상 종료·일관된 DB 백업 뒤 설치 전환.
- 인증서 없는 개인용 배포의 GitHub 업데이트 활성화, 일반 검사/개발 실행 비활성화. 게시 토큰·저장소·버전/태그·Windows x64 산출물·무결성 검사와 GitHub Actions 정의.
- 설치/업데이트/복구/CI 설정 방법은 [docs/DESKTOP.md](../../../docs/DESKTOP.md)에 기록했다.

## 실행한 검증

| 검증 | 결과 | 근거 |
| --- | --- | --- |
| 기존 백엔드 기준선 | 통과 | 구현 전 15개 파일 / 86개 테스트 |
| 최종 백엔드 자동 테스트 | 통과 | `./scripts/npm.ps1 run test:run --workspace backend`: 18개 파일 / 99개 테스트 |
| 프런트 자동 테스트 | 통과 | `./scripts/npm.ps1 run test:run --workspace frontend`: 28개 파일 / 150개 테스트 |
| 데스크톱 업데이트·배포·접근 경계·창 수명 검사 | 통과 | `./scripts/node.ps1 --test desktop/test/*.test.cjs`: 71개 테스트. 개인용 정책·실제 NSIS 해시 실패·CI 토큰 연결·개인용 main IPC 및 smoke 활성 확인 포함. 로그 `.logs/desktop-personal-tests.log` |
| 백엔드 인증·게이트웨이 재검증 | 통과 | `test/desktop-lifecycle.test.ts test/desktop-gateway.test.ts`: 2개 파일 / 11개 테스트. 누락·잘못된 토큰 및 미인증 SSE 거절 포함. 로그 `.logs/desktop-security-backend.log` |
| 백엔드 수명·게이트웨이·소유권 재검증 | 통과 | 같은 두 파일 및 `test/desktop-ownership.test.ts`: 3개 파일 / 12개 테스트. 로그 `.logs/desktop-lifecycle-backend-final.log` |
| 여러 업무의 실제 설치 보류 및 쓰기 제한 | 통과 | `--service-directory .tools/desktop-stage-lifecycle/service --isolated --busy-sessions --read-only-service`: 서비스·Node 자식의 설치 경로 쓰기 거절 후 실제 SQLite·CLI·상태 조회·설치 보류·백업 복원 통과. 로그 `.logs/desktop-service-readonly-final.log`, 임시 프로필 `OpenSpecBoard-service-검증 공간-Jywoyz/profile`. 기존 13001~13003 포트 true→true |
| Windows CI 구성 정적 검사 | 통과 | YAML 파싱, Windows x64 단일 빌드, 업로드·다운로드 산출물 이름 일치 및 숨김 출력 폴더 포함 확인. 실제 Actions 실행은 별도 |
| 게시 워크플로 연결 검사 | 통과 | `.logs/desktop-publish-workflow-check.cjs`: push 조건·build 의존·release 환경·contents 권한·로컬 파일 검사 후 단일 publish 스크립트 호출 확인 |
| 실제 산출물 오프라인 게시 조율 검사 | 통과 | `.logs/desktop-publish-dry-run.cjs`, 결과 `.logs/desktop-publish-dry-run.json`: 당시 종료 경합 수정 EXE(214,650,300바이트)·blockmap(223,197바이트)·latest.yml(359바이트)을 읽어 검사. gh/API는 전부 대역이며 실제 네트워크 게시 없음 |
| 프런트·백엔드 빌드 | 통과 | 프로젝트 Node/npm으로 `run build`, 실제 status 0. `.logs/desktop-personal-build-result.json` 및 stdout/stderr 기록. 프런트 청크 크기 경고는 유지 |
| 동봉 Node 서비스 통합 검사 | 통과 | `scripts/desktop-service-smoke.cjs`: 한글·공백 데이터 경로, 빈 소스, 프로젝트 등록, 동봉 OpenSpec CLI 조회, 열린 SSE 종료, 백업 복원 후 같은 업무·fixture 대화 식별자 확인 |
| 저장소 밖 복사본 및 게이트웨이 통합 검사 | 통과 | `--packaged --isolated`: `%TEMP%/OpenSpecBoard-service-검증 공간-z5hlPE/profile`, 로그 `.logs/desktop-service-isolated.log`. 복사본 Node 24.15.0·SQLite, 시스템 Node PATH 및 상속 Node 검색 경로 제거, 정적 HTML 인증, 실제 API·SSE 전달, 중복 소유 거절, 종료 후 재획득·백업 복구 확인 |
| 게이트웨이 통합 검사 최종 재실행 | 통과 | `--packaged`: `.tools/desktop-service-검증 공간-TD46bf`, 로그 `.logs/desktop-service-gateway.log`. SSE 읽기 제한 시간 적용 후 전체 시나리오 통과. 기존 13001~13003 포트 전후 모두 연결 가능 |
| 백업 실패 검사 | 통과 | `scripts/desktop-service-smoke.cjs --packaged --backup-failure`: `.tools/desktop-service-검증 공간-VpSpuY`, 의도적 백업 경로 오류, shutdown-error 후 exit 1, 원본 DB 보존. 게이트웨이 추가 후 재검증 |
| Electron 기본 숨김 smoke | 통과 | 최종 패키지를 `--copy-to-temp --security`로 실행. `.tools/desktop-smoke-검증 공간-dihGOl`에서 창 재표시 없이 격리·IPC·정상 종료·백업 및 exit 0 확인. 로그 `.logs/desktop-smoke-default-final.log` |
| Electron 프로세스·격리·IPC·창 수명 smoke | 통과 | 최종 분리 패키지를 `--copy-to-temp --security --lifecycle`로 단독 실행. `.tools/desktop-smoke-검증 공간-Ij4fe8`에서 기동·인증 API·빈 소스·두 창 격리 설정·Node 전역 미노출·업데이트 메인 프레임 IPC·닫기 후 비파괴/숨김·트레이 콜백 재표시·서비스 유지·정상 종료·백업 및 exit 0 확인. 로그 `.logs/desktop-smoke-lifecycle-final.log` |
| Windows 최신 NSIS 설치 파일 생성 | 통과 | 개인용 업데이트 활성 패키지, `.tools/desktop-dist-integration`, 로그 `.logs/desktop-integration-dist.log`; 214,714,654바이트 미서명 설치 파일. 실제 app.asar의 정책·최신 주요 앱 소스 일치 검사 통과 |
| Windows 업데이트 메타데이터 | 통과 | `latest.yml` 버전·설치 파일 SHA-512 일치 확인, 별도 SHA-256 파일 생성 |
| OpenSpec 문서 엄격 검증 | 통과 | `openspec validate idea-1792902454517 --strict` |

서비스 통합 검사의 대화 식별자는 격리한 DB에 넣은 fixture다. 실제 AI CLI 인증이나 실계정 대화 재개 검증으로 취급하지 않는다. Electron 프로세스 smoke는 GUI를 직접 조작한 검증을 대신하지 않는다.

저장소 밖 검사는 서비스·프로필·프로젝트를 임시 폴더에 두고 복사한 동봉 Node만 PATH에 제공했다. 이 실행에서는 소스 체크아웃과 시스템 Node 경로를 사용하지 않았다. 시스템 Node가 아예 설치되지 않은 새 Windows VM이나 실제 설치 환경을 검증한 것은 아니므로 1.2·6.1은 미완료로 유지한다. 중복 소유자의 startup-error 및 exit 1 뒤 기존 소유자가 계속 API를 제공하고, 정상 종료 후 같은 프로필로 다시 준비되는 것까지 확인했다. 2.1의 서비스·게이트웨이 통합 조건을 완료했으며, 네이티브 재시도 대화상자·트레이·중복 실행 시 기존 창 표시 검증은 별도다. 기존 서버 공존은 포트의 검사 전후 연결 가능 여부만 확인했고 해당 프로세스를 종료하거나 재시작하지 않았다.

이전 0.1.0 통합 검사 산출물: `.tools/desktop-dist-integration/OpenSpecBoard-0.1.0-win-x64.exe`와 같은 이름의 `.sha256` 파일. SHA-256은 `3d801b3d037c1778d4a34e4b517001afbe30dbac9b9290f30c7e93ab6cd8e468`이다. 실제 산출물에 `desktop/artifacts.cjs`를 실행해 Windows EXE·메타데이터 버전·SHA-512 검사도 통과했다. 설치 파일을 생성했으며 사용자 PC에 설치하거나 기존 앱을 교체하지 않았다. 최신 공개 산출물은 위 v0.1.1 직접 게시 기록을 참고한다. 사용자 설치 확인을 최신 빌드의 확인으로 확대하지 않는다.

독립 코드 리뷰에서 지적된 종료 교착·중복 소유·백업 실패 종료 문제를 수정했고, 후속 소스 리뷰에서 추가 중요한 문제는 보고되지 않았다. 실제 배포 검증과 사용자 완료 확인을 이 리뷰로 대체하지 않는다.

## 발견 후 수정한 문제

- 업데이트 창의 상태 IPC 실패 후 설치 버튼이 활성화된 채 남고 버튼 IPC 실패가 미처리 rejection이 되던 문제: 두 실패를 테스트로 재현한 뒤 연결 오류 표시·버튼 차단·다음 정상 상태 조회 후 회복을 추가했다. 요청 중 중복 동작도 차단한다. 기존 준비·대기·설치 상태와 사용자 요청 조건은 유지한다.
- 최신 백엔드의 기본 알림 등록이 격리 검사에서도 사용자별 Windows 등록·시작 메뉴에 영향을 줄 수 있음을 독립 리뷰에서 확인했다. 서비스와 Electron smoke 모두 자식 시작 전 빈 검사 프로필의 알림을 비활성화했다. 사용자의 기존 등록을 임의로 삭제하거나 복원하지 않았다. 이 보완 후 후속 리뷰에서 추가 중요 간섭 문제는 발견되지 않았다.
- 실제 창 재표시 검사에서 실행기의 `windowsHide:true` 때문에 표시 이벤트가 있어도 창이 보이지 않았다. 동일 패키지에서 숨김 실행은 실패하고 `--lifecycle`의 숨김 해제 실행은 통과하는 것을 확인했다. 표시 대기 시간 보완은 채택하지 않았고, 검사 실행기만 조정했다. 실패한 검사 앱도 정상 종료·백업되었다. Windows 트레이 자체를 사용자가 클릭한 검증으로 확대하지 않는다.
- 후속 리뷰에서 창 재표시 검사가 기본 숨김 smoke에도 적용되는 회귀를 확인했다. 기본 모드는 창 닫기를 호출하지 않아야 한다는 테스트의 실패를 먼저 확인하고, runner가 명시적 `--lifecycle`에만 `--desktop-lifecycle-test`를 전달하며 main도 해당 인자에서만 창 검사를 수행하도록 수정했다. 기본·명시 모드 테스트와 후속 소스 리뷰를 통과했다.
- 업데이트 IPC가 같은 URL의 하위 프레임을 허용하던 문제: 창 ID와 URL 검사에 `senderFrame === webContents.mainFrame`을 추가했다. 잘못된 창·URL·null 프레임·같은 URL 하위 프레임의 거절을 실제 main 소스를 실행하는 Electron API 대역으로 확인했다. 토큰 주입 범위, 권한 요청 거절, 외부 탐색·팝업 차단, 최소 preload도 같은 방식으로 검사했다. 외부 브라우저는 실행하지 않았다. [Electron invoke 이벤트](https://github.com/electron/electron/blob/v45.0.0/docs/api/structures/ipc-main-invoke-event.md), [메인 프레임 계약](https://github.com/electron/electron/blob/v45.0.0/docs/api/web-contents.md#contentsmainframe-readonly)
- 격리한 앱 검사 실패 시 소유 서비스가 남을 수 있는 문제: 빈 검사 프로필만 허용하고 실패 후 서버 자체의 유휴 판정·정상 종료·백업을 시도하도록 했다. 실패 종료 코드 1은 유지하며 강제 종료하지 않는다. 실패 경로 대역 검사와 후속 독립 소스 리뷰를 통과했다.
- 첫 실행 빈 소스 목록에서 파일 감시기의 ready를 계속 기다리던 문제: 빈 목록이면 감시 준비를 바로 마친다.
- 열린 SSE로 Nest 정상 종료와 백업이 대기하던 문제: 설치 잠금 후 신규 읽기 요청도 차단하고 기존 읽기 연결을 종료한다. 실패 재현 후 통합 검사 통과.
- 동일 데이터의 중복 세션 시작: OS 배타 소유 잠금과 재획득 테스트 추가.
- 서버가 이미 종료됐거나 백업에 실패한 뒤 앱 종료가 막히던 문제: 종료된 서버는 안전하게 정리하고, 백업 실패 서버는 오류 통지 후 잠금을 해제하여 exit 1 처리.
- 패키징 도구의 기본 필터가 서버의 root `node_modules`를 제외하던 문제: 별도 리소스 복사와 afterPack 의존성·런타임 누락 검사 추가. 소스 저장소 밖의 복사본에서 Electron smoke 통과.
- 미저장 문서로 화면이 닫기를 거절한 뒤 서버만 종료될 수 있는 문제: 서버 종료 전 기존 beforeunload 보호를 검사하고 확인 실패도 종료 보류한다.
- 설치 전환 뒤 재요청으로 종료·설치를 중복 실행할 수 있는 문제: 테스트에서 2회 호출을 재현하고 installing 상태의 재진입을 차단했다.
- 업데이트 확인의 완료 이벤트와 Promise 종료 사이에 중복 확인이 들어갈 수 있는 경합: 확인 중 여부를 별도로 유지하여 시작·주기·수동 호출을 함께 차단했다. 시작 및 4시간 간격과 종료 시 타이머 정리도 가상 시계로 검증했다.
- updater가 잘못된 OS·아키텍처 파일로 대체 선택할 수 있는 문제: 다운로드 전 정식 버전·태그 일치와 정확한 플랫폼 파일명을 검사한다. 다른 플랫폼 파일이 섞이거나 호환 파일이 없으면 오류로 차단하고 기존 최소 OS 지원 검사는 유지했다.
- 릴리스 파일 검사가 다른 버전 파일·중복 항목·DMG 메타데이터 누락을 통과시키던 문제: 각 사례의 실패 테스트를 먼저 재현한 뒤 정확한 세 플랫폼 파일 이름과 EXE·ZIP·DMG 전체 메타데이터·해시를 검사하도록 수정했다.
- Windows 전용 전환 후에는 EXE·`latest.yml`만으로 검사를 통과하고 다른 플랫폼 파일이 섞이면 차단한다. macOS 파일을 필수 산출물로 요구하지 않는다.
- 새 CI checkout의 `.tools` 미존재로 스테이징이 실패하던 문제: 실제 빈 임시 루트에서 ENOENT를 재현한 뒤 고정 경로 생성과 외부 링크 거절을 구현했다. 기존 stage만 정리하고 다른 `.tools` 파일과 링크 밖 파일을 보존하는 테스트도 통과했다.
- 숨김 폴더의 CI 산출물 업로드 누락: `include-hidden-files: true`를 명시하고 업로드 경로를 EXE·blockmap·`latest.yml`로 한정했다. [upload-artifact의 숨김 파일 정책](https://github.com/actions/upload-artifact#uploading-hidden-files)을 근거로 검토했다.
- 앱 종료와 업데이트 설치의 경합: 준비 전에 공통 소유 토큰을 획득하고 종료·백업·취소까지 전달한다. 기존 요청의 잠금을 다른 요청이 해제하지 못하며, 설치가 자식 종료 후 게이트웨이를 정리하는 동안에도 다른 앱 종료 요청이 앞서 종료하지 못하도록 했다.
- 서버 잠금 후 준비 응답을 받지 못한 경우: 기존 로직에서 cancel 미호출과 gate 조기 해제를 테스트로 재현했다. 같은 소유 요청이 서버 취소를 시도하며, 취소 실패 시 gate 차단을 유지하고 명시적 재시도를 허용한다. 미저장·처리 중 요청의 사전 차단은 서버 호출 전에 유지한다. 후속 독립 리뷰에서 추가 중요한 문제는 발견되지 않았다.
- 초안 게시 조율: 같은 태그의 기존 릴리스·조회 실패·초안 생성 경합·업로드 실패·원격 파일 누락/중복/크기/해시/완료 상태 불일치·로컬 파일 변경은 게시로 이어지지 않는 테스트를 추가했다. EXE·EXE.blockmap·메타데이터의 정해진 세 파일만 업로드하고 덮어쓰기 옵션을 사용하지 않는다.
- 독립 리뷰에서 태그 조회 API가 게시된 릴리스 전용이라 신규 초안을 찾지 못하는 문제를 확인했다. 공식 API 계약을 반영한 대역에서 실패를 재현한 뒤 인증된 전체 페이지 목록 조회와 유일한 태그 선택으로 수정했다. 다중 페이지·누락·중복 태그 테스트 및 후속 소스 리뷰를 통과했다. [GitHub 릴리스 API](https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name), [파일 digest 계약](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)

업데이트 네트워크 실패·다운로드 진행률 검사는 이벤트 기반 updater 대역으로 수행했다. 실제 GitHub 호출 제한 발생이나 정식 파일 다운로드를 재현한 것은 아니다. 실제 두 버전 간 전환은 6.2에서 별도 검증한다. 4.2의 상태 연결 및 오류·재시도 검증을 마쳐 작업 완료로 표시했다. 후속 독립 소스 리뷰에서도 이 변경의 중요한 회귀 문제는 보고되지 않았다.

4.1은 설치된 electron-updater의 실제 AppUpdater·GitHubProvider에 HTTP 응답 대역을 연결해 검증했다. 높은 정식 버전 선택, 같은·낮은·사전 버전 제외, 공개 latest에 정식 버전이 없을 때 다운로드하지 않음, Windows/macOS 채널 분리, 태그·OS·아키텍처 불일치 차단을 확인했다. 실제 GitHub 릴리스를 생성하거나 초안을 게시하지 않았다. 독립 리뷰에서 설치된 electron-builder의 Mac ZIP·DMG 메타데이터 병합 계약과의 일치도 확인했다.

## 실행 환경 제한과 남은 검증

- 제한 실행 환경에서 npm/빌드 보조 파일 다운로드가 EACCES로 실패했다. 승인된 권한 범위에서 공식 npm·Electron·NSIS 파일을 내려받아 빌드를 진행했다.
- 제한 환경이 생성한 폴더의 AppContainer ACL로 Electron 자체가 실행을 거절했다. ACL이나 샌드박스를 변경하지 않고 승인된 임시 복사본 실행으로 검사했다.
- 후속 빌드에서 기본 desktop-stage 재생성과 desktop-dist EXE 교체가 EPERM으로 실패했다. 기존 앱을 종료하거나 ACL을 변경하지 않고 `DESKTOP_STAGE_NAME=desktop-stage-shutdown`과 별도 출력 `.tools/desktop-dist-shutdown`으로 빌드했다. 경로 이름·root 하위 범위·링크 검사를 유지하고, 기본 실행 폴더 보존 테스트와 builder app/extraResources 일치 검사를 통과했다.
- 빌드와 동시에 진행한 앱 검사 한 차례에서 종료·백업 후 프로세스가 지연됐다. 당시 프로세스 조회도 메모리 부족 오류를 반환했다. 원인을 앱 로직으로 단정하지 않았고, 격리 테스트의 잔류 프로세스만 정리했다. 종료 이벤트 로그를 추가하여 빌드와 분리한 단독 실행 2회에서 before-quit·will-quit·quit 및 exit 0을 확인했다. 메모리가 제한된 환경에서는 패키징과 앱 검사를 동시에 실행하지 않는다.
- Edge 화면 검증은 사용자의 최신 지시로 제외했으며 수행하지 않는다. 다른 브라우저 검증으로 대체하지 않는다.
- macOS 실제 설치·창·메뉴 막대·서명·공증·업데이트 검증은 지원 범위 삭제에 따라 제외했다.
- 2026-10-26 개인용 미서명 정책으로 인증서 준비와 실제 인증서 검증은 요구하지 않는다. GitHub 두 버전 간 다운로드·재시작 설치는 여전히 미검증이다. 릴리스 게시·태그 push·CI 실행·계정 설정 변경은 하지 않았다.
- 5.3의 게시 흐름·실패 사례·운영 절차는 구현 및 로컬 대역 검사로 완료했다. 원격 릴리스·업로드 상태·digest 응답은 테스트 대역이며 GitHub 서버에서 실제로 확인한 결과가 아니다. 실제 Actions 실행·두 버전 전환은 각각 5.1·6.2에 남긴다. 5.2는 인증서를 요구하는 과거 조건에서 개인용 기본 GitHub 토큰 연결로 변경해 로컬 검증을 완료했다.
- 정식 서명 실패와 배포자 검증은 로컬 정책/오류 처리 테스트까지만 확인했다. 실제 인증서 검증을 통과했다고 주장하지 않는다.
- 검토 중 코드 리뷰에서 발견한 문제는 수정했지만 Windows 앱의 남은 구현·실제 검증과 사용자 결과 확인이 남아 있다. 관련 tasks 체크박스는 전체 조건이 충족될 때만 완료한다.

2.4는 백엔드 인증 거절 검사, 실제 main 소스의 Electron API 대역을 통한 잘못된 발신자·외부 탐색 거절 검사, 실제 Electron의 격리 설정·정상 IPC 검사와 기존 실제 게이트웨이 API·SSE 전달 결과를 함께 근거로 완료했다. 실제 GUI 탐색 조작이나 트레이·설치 검증을 완료했다는 의미는 아니다.

2.3은 실제 소유 잠금 중복 거절·실패 후 재획득·기존 포트 공존과 main 소스의 중복 앱 차단·기존 창 표시·게이트웨이 시작 실패 시 소유 자식 정상 종료 대역 검사로 완료했다. 실제 Electron의 OS 단일 인스턴스 메시지 전달은 수동 설치 검증에서 별도로 확인한다.

3.1은 실제 Electron의 닫기·숨김·트레이 이벤트 콜백·서비스 유지, main 소스의 종료 보류·미저장 보호·유휴 재시도 검사와 실제 서버의 다른 업무 실행·연결·질문·승인 상태 검사로 완료했다. `--busy-sessions`의 질문·대화·업무는 새 DB fixture이며 실제 AI 작업을 실행하지 않았다. 다운로드 오류는 updater 이벤트 주입이고 설치기는 대역이다. 실제 서명·체크섬 오류나 실제 앱 교체를 수행한 결과가 아니다.

초기 쓰기 제한 검사는 Node 권한 모델로 서비스와 상속된 Node 자식에 적용했다. 당시 이 검사만으로 1.2·2.2·6.1을 완료 처리하지 않았다. 이후 위의 실제 Windows ACL 검사에서 전체 앱 복사본을 읽기 전용으로 두고 Electron과 서비스의 영속 데이터 생성·재실행·복원을 확인해 2.2를 완료했다. 시스템 Node 미설치 새 VM 및 실제 설치 검증인 1.2·6.1은 별도다.

현재 추적 진행률은 21/29다. 개인용 배포 정책과 최초 직접 게시에 이어 무설치 ZIP·자동 업데이트의 7.1~7.5를 완료했다. 실제 Actions 실행·별도 Windows 환경·추가 사용자 UI 확인 등 남은 조건이 충족되지 않은 항목은 체크하지 않았다. 4.4·6.2의 전체 검증을 이번 제한된 무설치 검사만으로 완료 처리하지 않는다.

## 사용자 승인 후 GUI 조작 시도

- 사용자가 OpenSpecBoard 화면 접근·조작을 허용했다고 명시했다. 이후 `computer-use`의 `@oai/sky`로 실제 앱 창을 찾아 화면 읽기를 수행했다. 현재 업무가 실행 중인 화면임을 확인했으며 사용자 앱을 종료하거나 설치본을 교체하지 않았다.
- 메뉴 클릭·창 활성화·키 입력에서는 도구가 반복적으로 `user input was detected in this window; call get_window_state before continuing`를 반환했다. 재관찰 후에도 입력이 보류되어 메뉴·OS 트레이 조작 성공으로 기록하지 않는다. 별도 검사 창의 캡처에도 기존 업무 화면이 겹쳐 보여 대상 창 가시성을 검증하지 못했다.
- 기존 업무와 분리하기 위해 `.logs/desktop-ui-qa`에서 전용 프로필 `.tools/desktop-ui-qa-qoDREv`의 검사 앱을 실행했다. 알림을 비활성화했고 서비스 준비·빈 프로젝트 설정을 확인했다. 조작 보류 후 프로젝트·업무가 모두 0개인 것을 SQLite 조회로 확인하고, 생성한 PID 314124와 명령줄·부모 관계가 일치하는 자식만 종료했다. 프로필은 보존했다. 이 정리는 정상 종료·백업 GUI 검증의 근거가 아니다.
- 제품 코드는 수정하지 않았다. 실제 설치·업데이트·OS 트레이 수동 검증과 6.4는 미완료이며 진행률도 11/23을 유지한다.
- 사용자가 이 업무의 권한 요청을 승인하겠다고 알리고 진행을 재지시한 뒤에도 재시도했다. 새 화면 관찰 후 메뉴 클릭은 완료 결과를 반환했으나 메뉴가 열린 결과를 화면에서 확인하지 못했고, 다시 관찰한 뒤 F10 키 입력은 같은 사용자 입력 감지 메시지로 보류됐다. 사용자에게 접근 승인을 받지 못한 상태로 표현하지 않는다. 현재 화면 조작 경로의 입력 보류 원인을 앱 기능의 실패로 단정하지 않으며 동일 승인을 반복 요청하지 않는다. 현재 업무의 종료·설치 교체·트레이 조작 성공은 확인되지 않았다.
