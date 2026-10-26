import { expect, it } from 'vitest';
import { sanitizeDiagram } from './mermaidRenderer';

// Representative native-SVG geometry from the required Mermaid grammars.
it.each([
  ['flowchart', '<svg viewBox="0 0 200 100"><g class="node" transform="translate(20,20)"><rect width="80" height="40"/><text>시작</text></g><path class="flowchart-link" d="M100 40L180 40"/></svg>'],
  ['sequenceDiagram', '<svg viewBox="0 0 200 100"><rect class="actor" width="60" height="30" fill="#eaeaea"/><text>사용자</text><line class="messageLine1" x1="20" y1="40" x2="180" y2="40" stroke="none" stroke-width="2"/></svg>'],
])('%s의 정제된 SVG 구조를 보존한다', (_grammar, svg) => {
  expect(sanitizeDiagram(svg)).toMatchSnapshot();
});
