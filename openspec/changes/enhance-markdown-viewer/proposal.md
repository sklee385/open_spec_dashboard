# Proposal

## Why

현재 문서 화면은 기본 ReactMarkdown 렌더링을 사용하며 표와 다이어그램을 위한 확장 설정이 없다. 사용자가 작성하거나 AI가 생성한 Markdown 문서를 작업 화면에서 구조와 내용을 유지한 채 읽을 수 있도록 뷰어를 개선해야 한다.

## What Changes

- 업무 문서 미리보기, 변경 상세, 명세 조회에 일관된 Markdown 렌더링 기준을 적용한다.
- 제목, 목록, 체크리스트, 코드 블록, 링크, 이미지와 표를 문서 구조에 맞게 표시한다. 표의 행·열과 정렬을 유지한다.
- 지원 대상으로 정한 다이어그램 코드 블록은 실제 도식으로 표시한다. 잘못된 문법은 오류와 원문을 확인할 수 있게 한다.
- 넓은 표와 큰 다이어그램은 문서 화면을 깨뜨리거나 내용을 잘라내지 않고 열람할 수 있게 한다.
- 같은 문서에는 작성 주체와 무관하게 같은 표시 규칙을 적용하고, 편집 원본은 Markdown으로 유지한다.
- 제외 범위: WYSIWYG 편집기, Markdown 파일 형식 변경, 모든 다이어그램 언어 지원, 문서 내 임의 스크립트 실행.

## Capabilities

### New Capabilities

- `markdown-rendering`: 업무 문서의 Markdown 요소, 표와 다이어그램을 일관되게 렌더링하고 큰 콘텐츠 및 렌더링 오류를 처리하는 기능.

### Modified Capabilities

없음. 현재 기본 명세 목록은 비어 있다. 진행 중인 `unified-codex-work-session`의 `artifact-editing`에 정의된 문서 미리보기 위에 표시 요구사항을 추가하며 저장·충돌 처리 범위는 유지한다.

## Impact

- 프런트엔드: `WorkRoom.tsx`, `DetailModal.tsx`, `SpecsView.tsx`의 ReactMarkdown 사용과 문서 스타일. 문서용 공통 렌더러를 검토한다.
- 의존성: 표·체크리스트용 Markdown 확장과 다이어그램 렌더링 도입을 검토해야 한다. 현재 프런트엔드에 해당 확장 패키지는 선언되어 있지 않다.
- 설계 결정: GFM 표·체크리스트와 Mermaid를 지원한다. 표·코드 스크롤, 도식의 25~200% 확대·초기화 및 오류 시 원문 열람을 제공한다. URL 허용 기준과 HTML·SVG 실행 제한은 design.md 및 specs/markdown-rendering/spec.md를 따른다.
- 기존 문서 저장 API와 Markdown 파일을 유지하며, 악성 HTML이나 다이어그램 입력으로 문서 밖 동작이 실행되지 않도록 렌더링 경계를 정의한다.

## Source Ideas

- `source-ideas/idea-1792851605691.md`: Markdown 뷰어 고도화: 다이어그램·테이블 등 문서 요소 완전 지원.
