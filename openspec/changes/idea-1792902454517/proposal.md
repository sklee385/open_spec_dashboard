# Proposal

## Why

현재 OpenSpecBoard는 여러 로컬 서버와 브라우저를 직접 실행해야 한다. 현재 대시보드를 Windows 설치형 앱으로 제공하고 GitHub 기반 자동 업데이트로 새 버전 배포와 설치를 단순화한다.

사용자는 복구된 `windows_app_target` 질문에 “현재 OpenSpec 대시보드”라고 답했다. 별도 프로그램이 아닌 현재 대시보드가 이 변경의 대상이다.

## What Changes

- 기존 React 화면과 Node 백엔드를 실행하는 Windows 데스크톱 앱 및 설치 파일을 제공한다.
- 설치 경로와 업무 데이터·설정·사용자 프로젝트 경로를 분리한다.
- GitHub Releases에서 새 버전을 확인하고 다운로드·설치 상태와 실패 시 재시도를 제공한다.
- 사용자 한 명이 사용하는 개인용 앱으로, Windows 코드 서명 인증서 없이 지정한 공개 GitHub 저장소에서 업데이트한다. 2026-10-26 사용자 지시로 서명 필수 정책을 대체한다. 파일 해시·버전·저장소 확인과 업무 종료 보호는 유지한다.
- 실행·연결·질문·승인 대기가 있는 동안 업데이트 설치와 세션 종료를 보류한다.
- 자동 확인·다운로드 후 사용자가 “업데이트하고 재시작”을 선택하면, 모든 업무가 유휴 상태일 때 설치하는 정책을 제안한다.
- 배포는 Windows x64 사용자별 설치를 대상으로 하며 앱 실행에 필요한 Node 런타임은 동봉한다. AI CLI와 인증은 사용자의 기존 설치를 이용한다.

범위 밖: macOS·Linux 배포, Edge 화면 검증, 새로운 업무 기능, AI CLI 자체의 설치·업데이트, 실행 중 업무의 강제 중단. macOS와 Edge 화면 검증 제외는 사용자의 최신 지시에 따른다.

## Capabilities

### New Capabilities

- `windows-desktop`: Windows 설치형 앱 실행, 로컬 프로세스 관리, 데이터 보존과 기존 환경 공존.
- `desktop-updates`: GitHub 릴리스 확인·다운로드·안전한 설치·오류 복구 및 배포 계약.

### Modified Capabilities

없음. 기존 업무·문답·구현 시작·사용자 검토 계약을 데스크톱에서도 그대로 준수한다.

## Impact

데스크톱 실행 계층, 패키징·배포 설정, GitHub Actions와 업데이트 화면을 추가하는 계획이다. 기존 `backend/src/runtime.ts`, OpenSpec CLI 실행 경로, `DATA_DIR`/`CONFIG_PATH`, 게이트웨이 정적 파일 제공과 세션 수명 관리를 패키징 환경에 맞게 연결해야 한다. 기존 웹 실행 스크립트와 개발용 13001~13003 포트는 유지한다.

- 데스크톱 구성은 Electron + electron-builder + electron-updater를 권장한다.
- GitHub 배포 저장소는 현재 프로젝트의 Git 원격 저장소인 `sklee385/open_spec_dashboard`를 사용한다.
- 저장소는 공개 저장소이다. 

이 문서는 검토용 초안이다. 문서 생성·검증 또는 검토 항목 조회는 사용자 문서 검토 완료나 구현 시작을 의미하지 않는다.
