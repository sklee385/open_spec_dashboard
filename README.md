# OpenSpec 업무 공간

아이디어부터 개발 완료까지 같은 Codex 대화로 진행하는 로컬 작업 공간.
원본 UI 출처와 라이선스는 [UPSTREAM.md](UPSTREAM.md)를 참고한다.

## 개발 환경

Node.js 22.13 이상. `npm install` 후 별도 터미널에서 다음 명령을 실행한다.

```powershell
npm run dev:backend
npm run dev:frontend
```

- React 화면: http://127.0.0.1:13001
- NestJS API: http://127.0.0.1:13002/api/health
- 기존 설치본의 http://127.0.0.1:13000 은 유지한다.
- `npm run build`로 빌드하고 `npm test`로 테스트한다.

진행 중인 구현과 검증 여부는 `openspec/changes/unified-codex-work-session/tasks.md`에 기록한다.

- [같은 대화로 업무 진행하기](docs/USAGE.md)
- [API 계약](docs/API.md)
- [Codex 연결과 복구](docs/CODEX.md)
- [실제 실행·자동 테스트 검증 기록](docs/VERIFICATION.md)
