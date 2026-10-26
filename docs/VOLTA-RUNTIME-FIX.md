# Volta 권한 오류 수정

원인: 시스템 PATH의 node/npm은 `C:/Program Files/Volta` 중계기다. 제한된 실행 환경에서는 이 중계기가 사용자 Volta 폴더를 만들거나 오류 로그를 쓰지 못해 명령 실행 전에 실패했다. 서버 오류 로그와 업무 실행 기록에서 동일한 오류를 확인했다.

수정: 설치된 Node 24.15.0과 npm 11.12.1 원본을 프로젝트 `.tools/node-runtime`으로 복사했다. 원본 및 시스템 ACL은 수정하지 않았다. scripts/start.ps1, scripts/node.ps1, scripts/npm.ps1이 이 실행 파일을 직접 사용한다. 새 Codex 프로세스에도 같은 PATH를 명시하고 기본 검증 명령은 npm CLI를 Node로 직접 실행한다. 직접 등록한 다른 실행 파일은 유지한다.

검증: 관련 테스트 22개 및 백엔드 빌드 통과. 추가 권한 요청 없이 프로젝트 Node/npm 실행을 확인했다. 실제 Codex `command/exec`의 workspace-write 샌드박스에서 Node, npm, npx 버전 조회가 exitCode 0, stderr 공백으로 완료됐다. Windows PowerShell에서 npm.ps1이 실행 정책에 걸리는 점도 확인해 설치 파일에서 제외하고 npm.cmd를 사용한다. 전역 실행 정책은 변경하지 않았다.

반영: 작업 중 기존 백엔드 연결이 끊겨 새 실행 스크립트로 복구했다. 대화·질문·문서·업무 기록은 보존하며, 연결이 종료된 업무는 같은 대화로 재개한다. 기존 프런트엔드가 정상 실행 중이면 시작 스크립트가 유지한다.
