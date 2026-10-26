# Proposal

## Why

AI가 작성한 제안서·명세·설계에 흩어진 가정과 미결정 사항을 확인하려면 사용자가 문서 전체를 다시 읽어야 한다. 확인하거나 결정해야 할 항목과 해당 원문을 한곳에서 검토할 수 있어야 한다.

## What Changes

- 변경 상세 화면의 Proposal / Specs / Tasks / Design 옆에 사용자 검토 탭을 제공한다. 현재 주 작업 화면인 WorkRoom에서도 같은 변경의 검토 항목에 접근할 수 있게 한다.
- AI가 문서에서 명시한 확인 필요 요구사항, 가정, 미결정 사항, 선택지를 모아 표시한다.
- 각 항목을 출처 문서와 연결하여 원문을 확인하고 같은 업무에서 수정·질의응답을 이어갈 수 있게 한다.
- 문서가 바뀌면 검토 목록도 최신 내용에 맞게 갱신하고, 항목이 없는 상태와 목록을 읽지 못한 상태를 구분한다.
- 탭 열람만으로 기존 업무의 문서 검토 완료나 구현 시작을 처리하지 않는다.
- 제외 범위: 문서의 의미를 추측하여 임의로 승인 항목을 생성하는 기능, 자동 승인 및 기존 AI 확인 질문·답변 기능의 대체.

## Capabilities

### New Capabilities

- `document-review-items`: 변경 문서의 사용자 검토 항목을 모아 표시하고 원문 및 최신 문서와 연결하는 기능.

### Modified Capabilities

없음. 현재 기본 명세 목록은 비어 있다. 진행 중인 `unified-codex-work-session`의 `artifact-editing`, `requirement-clarification`과 연결하되 이 변경에서는 검토 항목 모음의 동작을 별도로 정의한다.

## Impact

- 프런트엔드: `frontend/src/components/DetailModal.tsx`의 탭 구성과 `WorkRoom.tsx`의 문서·질문 영역.
- 백엔드: 변경 문서 조회와 파일 변경 알림을 활용한 검토 항목 조회. 기존 문서 저장·버전 충돌 및 명시적 검토 절차와 호환해야 한다.
- 설계 결정: `[review:종류]`로 명시된 목록 항목을 원문 위치·문서 버전과 함께 조회한다. 수동 문서에도 동일 규약을 적용하며 항목별 승인 상태는 추가하지 않는다. 구체적인 규약과 갱신 방식은 design.md 및 specs/document-review-items/spec.md를 따른다.

## Source Ideas

- `source-ideas/idea-1792855326126-ef1a6209.md`: AI 작성 문서의 사용자 검토 항목을 별도 탭으로 표시.
