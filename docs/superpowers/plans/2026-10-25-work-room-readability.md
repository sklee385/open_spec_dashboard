# Work Room Readability Implementation Plan

**Goal:** 승인된 작업 대화·권한·코드 표시 설계를 기존 업무 화면에 적용한다.

**Architecture:** WorkContent.tsx에 코드 및 Markdown 표시, ApprovalRequest.tsx에 권한 요청 설명을 분리한다. WorkRoom은 기존 API와 상태를 유지하고 대화 내용 변경에만 스크롤한다.

**Tech Stack:** React, TypeScript, react-markdown, Vitest, Testing Library. 외부 의존성 추가 없음.

1. WorkRoom.test.tsx에 최초 진입 및 스트리밍 갱신 스크롤, 승인 요약 및 기존 승인 payload, 코드 표시·복사·JSON 정리 회귀 테스트를 추가한다.
2. 번들 Node로 `node_modules/vitest/vitest.mjs run --config frontend/vite.config.ts --root frontend src/components/WorkRoom.test.tsx`를 실행해 새 동작이 없어 실패하는지 확인한다.
3. WorkContent.tsx, ApprovalRequest.tsx와 스타일 및 번역 문구를 추가한다. `JSON.parse` 성공 시에만 JSON을 정리하고 복사 실패는 UI로 알린다. 요청 원문과 미지원 속성은 상세 정보에 보존한다.
4. WorkRoom.tsx에서 공통 컴포넌트를 연결하고 대화 컨테이너에 ref를 부착한다. 대화 텍스트와 현재 pane이 바뀔 때 `scrollTop = scrollHeight`를 설정한다.
5. 회귀 테스트 및 전체 프런트엔드 테스트를 실행한다. TypeScript와 Vite 빌드 결과를 확인한다.
6. 기존 변경과 diff를 비교하고 실행 중 서버의 화면 모듈 및 API 응답을 확인한다. Edge 확장 접근 여부와 실제 브라우저 검증 범위를 보고한다.
