import mermaid from 'mermaid';
import { expect, it } from 'vitest';

it.each([
  ['흐름도', 'flowchart LR\nA[시작] --> B[완료]', 'flowchart-v2'],
  ['시퀀스', 'sequenceDiagram\n사용자->>서버: 문서 요청\n서버-->>사용자: 응답', 'sequence'],
])('실제 Mermaid 파서가 예제 %s를 해석한다', async (_name, source, diagramType) => {
  mermaid.initialize({ securityLevel: 'strict', htmlLabels: false, startOnLoad: false });
  expect(await mermaid.parse(source)).toMatchObject({ diagramType });
});

it('실제 Mermaid 파서가 잘못된 문법을 거부한다', async () => {
  await expect(mermaid.parse('flowchart LR\nA[열린 괄호')).rejects.toThrow();
});
