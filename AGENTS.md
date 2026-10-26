# 프로젝트 명령 실행

- Node/npm 실행은 프로젝트 전용 런타임을 사용한다. 시스템 PATH의 `node`, `npm`, `npx`는 Volta 중계기일 수 있으며 제한된 실행 환경에서 Volta 폴더 쓰기 권한 오류가 난다.
- Node 명령: `./scripts/node.ps1 <인자>`
- npm 명령: `./scripts/npm.ps1 <인자>` (예: `./scripts/npm.ps1 run build --workspace backend`)
- 개발 서버 시작: `./scripts/start.ps1`. 이미 실행 중인 포트는 유지한다.
- 일반 웹 서버 재시작은 `./scripts/restart.ps1 -Service backend`를 사용한다. 13003 세션 서버는 Codex와 질문·실행을 소유하므로 코드 수정 때 함께 종료하거나 자동 watch하지 않는다. 세션 로직 변경 반영은 업무가 모두 멈춘 뒤 `-Service session`으로 명시적으로 수행한다. 답변·승인 대기 중이면 세션 서버를 재시작하지 않는다.
- 런타임이 없으면 설치된 Node 배포 폴더를 `./scripts/setup-runtime.ps1 -NodeDirectory <폴더>`에 지정한다. 원본은 읽기만 하며 `.tools/node-runtime`으로 복사한다. 시스템 폴더 ACL이나 샌드박스 권한을 변경하지 않는다.
- 사용자 응답은 한국어로 간결하게 작성한다. 브라우저 검증은 Codex 내장 브라우저(코덱스 브라우저)를 사용한다. Microsoft Edge의 ChatGPT 확장을 통한 검증은 사용하지 않는다.
- 예외: OpenSpecBoard가 사용자가 등록한 로컬 테스트 시나리오를 실행할 때는 프로그램 전용 Playwright 라이브러리와 headless Chromium을 사용한다. 개인 브라우저·PC 입력·별도 브라우저 MCP를 사용하지 않으며, 테스트 서버와 데이터·허용 origin을 격리한다. 이 예외는 2026-10-26 사용자가 권장 방향의 개발을 승인한 범위에 적용한다.
