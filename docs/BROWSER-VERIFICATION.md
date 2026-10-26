# 백그라운드 브라우저 검증

업무 화면의 **백그라운드 브라우저 검증**에서 시나리오를 저장하고 실행한다. PC의 마우스·키보드·개인 브라우저를 사용하지 않는다. 브라우저는 동시 한 개이며 화면 크기는 1280×800이다.

## 준비

```powershell
./scripts/npm.ps1 install
./scripts/setup-browser.ps1
./scripts/npm.ps1 run build --workspace backend
```

설치는 프로젝트 `.tools/browser-runtime`에만 수행한다. 배포 준비에서도 해당 Chromium을 `service/browser-runtime`에 복사한다. 런타임이 없으면 자동 다운로드하거나 개인 브라우저로 대체하지 않는다. 회사 보안 정책의 실행 차단은 우회하지 않는다.

Windows 전용 기능이다. 준비 명령은 Windows .NET Framework C# 컴파일러로 프로세스 가드를 함께 만든다. PowerShell 실행 정책을 낮추지 않는다. 회사 정책이 가드나 Chromium 실행을 막으면 준비 오류를 표시한다. Job Object가 실행기·호스트의 비정상 종료 때도 소유한 하위 프로세스를 종료한다.

## 시나리오 등록

구현을 시작해 업무 전용 공간이 준비된 뒤 등록할 수 있다. 실행 파일은 `node` 또는 `npm run`이며 cwd는 업무 전용 공간 아래의 상대 경로다. 신뢰하는 프로젝트의 **테스트 데이터 전용 서버**를 지정한다. 하드코딩된 운영 DB 연결을 자동으로 안전하게 바꾸지는 못하므로 운영 연결을 사용하는 명령은 등록하지 않는다.

```json
{
  "name": "이름 저장과 새로고침",
  "server": {
    "command": "npm",
    "args": ["run", "dev:test", "--", "--host", "127.0.0.1", "--port", "14321", "--strictPort"],
    "url": "http://127.0.0.1:14321"
  },
  "steps": [
    { "op": "goto", "path": "/" },
    { "op": "fill", "target": { "role": "textbox", "name": "이름" }, "value": "테스트" },
    { "op": "click", "target": { "role": "button", "name": "저장" } },
    { "op": "expectText", "target": { "role": "status", "name": "결과" }, "value": "저장됨" },
    { "op": "reload" },
    { "op": "expectValue", "target": { "role": "textbox", "name": "이름" }, "value": "테스트" }
  ]
}
```

`dev:test`는 해당 프로젝트에서 테스트 전용으로 준비한 스크립트여야 한다. `server.cwd`로 `frontend` 같은 하위 폴더를 지정할 수 있다. 실행기에서 PORT/HOST, NODE_ENV=test, OPENSPEC_VERIFICATION=1, 실행별 DATA_DIR/CONFIG_PATH를 제공한다. 서버는 이 설정을 존중하고 지정한 주소를 사용해야 한다. 개인 환경변수와 앱의 DESKTOP_TOKEN은 전달하지 않는다. 기존 개발 서버는 재사용하거나 종료하지 않는다. 포트 13001~13003은 금지한다.

컴파일된 파일을 제공하는 서버라면 `dev:test`에서 최신 빌드를 먼저 생성해야 한다. 실행기는 작업 경로와 코드 버전을 확인하지만, 프로젝트 스크립트가 오래된 산출물을 제공하는지까지 자동으로 증명하지는 못한다.

요소는 정확한 role/name 또는 `{ "testId": "save" }`로 찾는다. 하나의 요소만 일치해야 한다. `expectVisible`, `expectText`, `expectValue`, `expectURL` 중 최소 한 번의 검사가 필요하다. 비밀번호·파일·숨겨진 필드 입력은 지원하지 않는다. API·WebSocket도 같은 origin만 허용하므로 테스트 서버에서 필요한 API를 제공하거나 테스트 전용 프록시를 구성한다. 프록시는 프로젝트의 신뢰된 테스트 설정이며 외부 운영 API로 연결하지 않아야 한다.

## 결과와 복구

통과·실패·차단·중단·다시 검증 필요를 구분한다. 실행한 단계와 마지막 화면을 확인할 수 있다. 화면과 결과는 AI 진단에도 전달될 수 있으므로 실제 개인정보·비밀값 대신 테스트 값을 사용한다. 서버 원문 로그·인증 상태 파일은 저장하지 않는다. 화면과 단계에 입력한 테스트 데이터는 결과에 남을 수 있다.

코드 또는 시나리오가 변경되면 과거 통과를 완료 근거로 쓰지 않는다. 브라우저 통과는 작업 테스트·전체 테스트·사용자 최종 확인을 대체하지 않는다. 중단과 결과 불명 시 저장·제출을 자동 반복하지 않는다.

Windows에서 Chromium이 페이지·입력 생성 전 메모리 접근 위반(`0xC0000005`)으로 종료됐다고 확인한 경우에만 브라우저 시작을 한 번 다시 시도한다. 시간 초과·권한 오류·사용자 중단은 반복하지 않으며, 입력이나 실패한 시나리오 단계도 다시 실행하지 않는다. 회복한 실행은 결과의 `startupAttempts`와 `startupRecovery`에 기록하고 두 번째 시작도 실패하면 차단 상태로 남긴다. Chromium 샌드박스는 계속 활성화한다.

종료 시에는 Playwright의 정상 종료 및 소유 프로세스 정리 예산(30초)을 포함해 최대 60초 기다린다. 이 동안 통신 경계를 유지하며, 종료가 확인되지 않으면 기존 단계 결과와 관계없이 차단 상태로 남긴다.

새 대화의 AI에는 `browser_verification`의 run/status/cancel만 제공한다. 설치된 Codex 스키마에는 thread/resume의 동적 도구 갱신이 없어 기존 대화는 업무 폴더 `.tools/browser-verification/cli.cjs`를 통해 같은 동작을 요청한다. 프로젝트 Node 런타임으로 CLI를 실행하며 HTTP·네트워크 권한·별도 MCP를 사용하지 않는다. 요청은 해당 업무에 고정되며 등록 명령이나 시나리오를 바꾸지 못한다. 처리 중 요청은 재시작 후 자동 재실행하지 않는다. 대화 ID와 원본 대화 기록을 수정하지 않는다.

시나리오를 등록하면 CLI가 준비되고 AI의 다음 지시에 실제 실행 명령이 포함된다. 결과 JSON의 `imagePath`는 업무 폴더 아래의 화면 파일이다. 통로가 끊기면 업무 화면에서 결과를 확인하고 저장 요청을 자동 반복하지 않는다.

OS 알림·트레이·네이티브 파일 대화상자·실제 모바일·CAPTCHA·외부 로그인은 이 검증의 범위 밖이다. 현재 서버를 운영 반영하려면 모든 실행과 질문·승인이 끝난 뒤 `./scripts/restart.ps1 -Service session`을 명시적으로 수행한다.
