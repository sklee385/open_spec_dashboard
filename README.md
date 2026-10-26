# OpenSpecBoard

<img src="frontend/public/openspecboard-icon.svg" alt="OpenSpecBoard 아이콘" width="64" height="64" />

아이디어부터 개발 완료까지 같은 Codex 대화로 진행하는 로컬 작업 공간.

Windows 설치형과 무설치 ZIP은 [v0.1.6 릴리스](https://github.com/sklee385/open_spec_dashboard/releases/tag/v0.1.6)에서 내려받을 수 있다. 실행·업데이트 방법은 [데스크톱 안내](docs/DESKTOP.md)와 [무설치 안내](docs/PORTABLE.md)를 참고한다.

## 참고 프로젝트

OpenSpecBoard는 [ToruAI/openspec-ui](https://github.com/ToruAI/openspec-ui)를 참고하고 원본 React UI를 바탕으로 고도화한 프로젝트다. OpenSpec 변경을 모니터링하는 화면에서 출발하여, AI와의 문답·문서 작성 및 수정·구현·검증·완료를 하나의 대화에서 진행하는 업무 공간으로 확장한다.

원본 프로젝트의 출처와 라이선스 정보는 [UPSTREAM.md](UPSTREAM.md)를 참고한다.

## 업무 삭제와 복원

아이디어와 초안·할 일·진행 중 업무의 휴지통 버튼으로 중단한 항목을 보드에서 숨길 수 있다. 삭제 확인 후에도 OpenSpec 원본 파일과 Codex 대화·실행 기록은 유지된다. 상단 **휴지통**에서 복원하면 기존 업무로 이어진다. 완료·보관된 업무는 이 삭제 대상에서 제외한다.

실행·연결·답변·승인 대기 중에는 먼저 업무 화면의 **현재 실행 중단**으로 실행을 중단해야 한다. 오래된 탭에서 삭제된 업무에 실행을 요청해도 서버가 거절한다. 휴지통 상태는 웹 게이트웨이의 `DATA_DIR/board-trash.json`(기본 `.data/board-trash.json`)에 저장되며 서버 재시작 후에도 유지된다. 원본 파일은 이동하지 않으므로 OpenSpec CLI에서는 계속 조회할 수 있다.

## 개발 환경

Node.js 22.13 이상. 프로젝트 전용 런타임 준비 방법은 [사용 안내](docs/USAGE.md)를 참고한다. 설치된 런타임으로 빌드한 뒤 다음 명령으로 세 서버를 독립 실행한다.

```powershell
./scripts/npm.ps1 install
./scripts/npm.ps1 run build --workspace backend
./scripts/start.ps1
```

- React 화면: http://127.0.0.1:13001
- 웹 API 게이트웨이: http://127.0.0.1:13002/api/health
- 대화·Codex 상주 세션 서버: http://127.0.0.1:13003/api/health
- 기존 설치본의 http://127.0.0.1:13000 은 유지한다.
- `./scripts/npm.ps1 run build`로 빌드하고 `./scripts/npm.ps1 test`로 테스트한다.
- 일반 재시작은 `./scripts/restart.ps1 -Service backend`로 웹 서버만 교체한다. 세션 서버 자체의 변경 반영은 업무가 멈춘 뒤 `-Service session`으로 수행하며, 질문·승인 대기가 있으면 종료를 보류한다.

현재 기능 계약은 `openspec/specs/`, 완료 변경의 작업·검증 기록은 `openspec/changes/archive/`에 보존한다. 새 변경의 진행 상태는 `openspec/changes/`에서 확인한다.

- [같은 대화로 업무 진행하기](docs/USAGE.md)
- [API 계약](docs/API.md)
- [Codex 연결과 복구](docs/CODEX.md)
- [실제 실행·자동 테스트 검증 기록](docs/VERIFICATION.md)
- [PC 입력을 점유하지 않는 브라우저 검증](docs/BROWSER-VERIFICATION.md)
# 사용자 검토

변경 상세와 업무 공간의 검토 탭 사용법 및 Markdown 표기 규약은 [사용자 검토 안내](docs/document-review.md)를 참고하세요.
