# 업무 복구 검증 기록

- 승인 설계: add-work-recovery. 기존 업무 재연결은 단계·대화·문서를 보존하며 AI 실행을 시작하지 않는다.
- TDD: GET recovery 진단 부재 3건과 복구 버튼 부재 3건을 실패로 확인한 뒤 구현했다.
- 독립 리뷰: 복구 이벤트가 기존 queued 지시를 실행하는 문제, 격리 경로 대화의 rollout 탐색 실패를 발견했다. 각각 실제 turn/start 증가 및 복구 409를 재현한 뒤 수정했다. 재리뷰에서 추가 중요 발견 없음.
- 전체 테스트: 프런트엔드 227 통과, 백엔드 248 통과·기존 조건부 검사 2 제외. 데스크톱 142 통과. 전체 빌드 통과(기존 Vite 청크 크기 경고 유지).
- 별도 배포 소스: 관련 백엔드 43, 프런트엔드 61 통과 및 빌드 통과. 확장된 통합 검사가 병행 부하에서 기본 5초를 초과하여 해당 통합 검사에 20초 제한을 명시하고 재검증했다.
- Codex 내장 브라우저: 기존 업무 복구 성공과 문서·대화 초안 보존, 손상 공간 복구 제한, 대화 점유 안내, 대화 ID 누락 안내 확인.
- 별도 Windows Electron 창: 복구 후 구현·대화 가능 상태, 같은 thread-1, 대화 초안 보존 확인. 검증 서버 RPC 기록은 thread/resume 2회, thread/start 및 turn/start 0회.
- Windows 화면은 테스트 프로필과 프로토콜 fixture를 사용했다. 실사용 앱·업무·13003 서버를 재시작하지 않았다. 기존 실제 사용자 대화의 복구 성공은 앞선 수동 복구에서 확인했으며 이번 새 기능 검증에서는 실제 AI 메시지를 전송하지 않았다.
- 증거: .logs/work-recovery-all-tests.log, .logs/work-recovery-build.log, .logs/recovery-release-backend-tests-final.log, .logs/recovery-release-frontend-tests.log, .logs/work-recovery-browser-success.png, .logs/work-recovery-browser-blocked.png, .logs/work-recovery-windows-success.png.

배포 파일·공개 다운로드 검증은 생성과 게시 후 아래에 추가한다.

## 배포 검증

- 배포 소스 커밋: 6c7c086e22df352abfa8b5e024713ab487bc25b8. 별도 codex/work-recovery-v0.1.3 브랜치와 새 v0.1.3 태그로 게시했다.
- 설치형 EXE·blockmap·latest.yml·무설치 ZIP·portable.json 생성과 SHA-512 메타데이터 검증 통과. 설치형·무설치 업데이트 정책, 백엔드 복구 모듈·Codex 서비스·업무 컨트롤러 및 프런트엔드 번들의 배포 소스 일치를 검사했다. 실제 ZIP 내부 복구 모듈도 검사했다.
- 두 배포판을 별도 빈 프로필로 기동해 인증 API·렌더러 격리·GitHub 업데이트 활성·정상 종료·백업 검사를 통과했다.
- GitHub Actions 40275310776은 기존 portable-install.test.cjs 테스트 5개에서 RUNNER~1과 runneradmin 경로 비교 차이로 실패했다. desktop와 .github/workflows/desktop.yml은 v0.1.2 대비 변경 없음. 자동 게시 단계는 skipped이며 이번 배포는 검증한 로컬 파일을 직접 게시한다. 원격 CI 성공으로 간주하지 않는다.
- 초안 릴리스 423891838에 파일 5개를 올렸고 원격 크기·업로드 상태·SHA-256과 소스 태그 커밋을 대조했다.
- 공개 릴리스: https://github.com/sklee385/open_spec_dashboard/releases/tag/v0.1.3
- 공개 후 파일 5개를 인증 없이 스트리밍 다운로드해 크기·SHA-256을 대조했다. latest.yml의 EXE SHA-512, portable.json의 ZIP SHA-512·파일 크기·버전이 실제 다운로드와 일치한다. 근거는 .logs/recovery-release-public-verification.json에 저장했다.
- 모든 추적 작업 12개 완료. 사용자 현재 앱은 자동 교체·재시작하지 않았으며 앱 업데이트 또는 공개 다운로드로 v0.1.3을 사용할 수 있다.
