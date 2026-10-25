import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MermaidBlock } from './MermaidBlock';

const renderer = vi.hoisted(() => ({ render: vi.fn(), initialize: vi.fn() }));
vi.mock('mermaid', () => ({ default: renderer }));
beforeEach(() => {
  renderer.initialize.mockReset();
  renderer.render.mockReset().mockResolvedValue({ svg: '<svg viewBox="0 0 800 600"><g><text>정상 도식</text></g></svg>', bindFunctions: vi.fn() });
});
afterEach(() => vi.restoreAllMocks());

it('strict·HTML 라벨 제한과 고유 ID로 렌더링하고 실행 가능한 SVG를 정제한다', async () => {
  const bind = vi.fn();
  renderer.render.mockResolvedValue({ svg: '<svg viewBox="0 0 800 600" onload="alert(1)"><script>alert(1)</script><foreignObject><img src="x" onerror="alert(1)" /></foreignObject><a href="https://evil.example"><text>링크</text></a><image href="https://evil.example/track"/><style>@import url(https://evil.example);</style><g onclick="alert(1)"><path fill="url(https://evil.example)" d="M0 0"/><text>정상 도식</text></g></svg>', bindFunctions: bind });
  const view = render(<><MermaidBlock source={'flowchart LR\nA-->B'} /><MermaidBlock source={'sequenceDiagram\nA->>B: hi'} /></>);
  await waitFor(() => expect(view.container.querySelectorAll('.mermaid-canvas svg')).toHaveLength(2));
  expect(renderer.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', htmlLabels: false, startOnLoad: false, suppressErrorRendering: true }));
  expect(renderer.render.mock.calls[0][0]).not.toBe(renderer.render.mock.calls[1][0]);
  expect(view.container.querySelector('script, foreignObject, a, image, style, [onload], [onclick], [href]')).toBeNull();
  expect(view.container.innerHTML).not.toContain('evil.example');
  expect(bind).not.toHaveBeenCalled();
});

it('문법 실패는 해당 블록의 안내와 원문으로 격리한다', async () => {
  renderer.render.mockRejectedValueOnce(new Error('parse failure'));
  render(<><p>나머지 문서</p><MermaidBlock source="wrong syntax" /><MermaidBlock source={'flowchart LR\nA-->B'} /></>);
  expect(await screen.findByRole('alert')).toHaveTextContent('다이어그램을 표시할 수 없습니다');
  expect(screen.getByText('wrong syntax')).toBeVisible();
  expect(await screen.findByText('정상 도식')).toBeVisible();
  expect(screen.getByText('나머지 문서')).toBeVisible();
});
it('내부 CSS를 제거해도 도형·텍스트·연결선을 읽을 수 있게 보존한다', async () => {
  renderer.render.mockResolvedValue({ svg: '<svg viewBox="0 0 200 100"><style>.node rect { fill: pink; } .flowchart-link { stroke: black; }</style><g class="node"><rect width="80" height="40"/><text>시작</text></g><path class="flowchart-link" d="M80 20 L120 20"/><defs><marker id="arrow"><path d="M0 0 L5 5"/></marker></defs></svg>' });
  const view = render(<MermaidBlock source={'flowchart LR\nA[시작]-->B[완료]'} />);
  await screen.findByText('시작');
  expect(view.container.querySelector('rect')).toHaveAttribute('fill', 'none');
  expect(view.container.querySelector('rect')).toHaveAttribute('stroke', 'currentColor');
  expect(view.container.querySelector('text')).toHaveAttribute('fill', 'currentColor');
  expect(view.container.querySelector('.flowchart-link')).toHaveAttribute('stroke', 'currentColor');
  expect(view.container.querySelector('marker path')).toHaveAttribute('fill', 'currentColor');
});

it('UTF-8 64KiB 초과를 렌더링 전에 차단한다', async () => {
  const source = '가'.repeat(22000);
  render(<MermaidBlock source={source} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('64KiB');
  expect(renderer.render).not.toHaveBeenCalled();
  expect(screen.getByText(source)).toBeVisible();
});

it('이전 비동기 결과가 수정한 초안을 덮어쓰지 않는다', async () => {
  let resolve!: (value: { svg: string }) => void;
  renderer.render.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<MermaidBlock source="old" />);
  await waitFor(() => expect(renderer.render).toHaveBeenCalledTimes(1));
  view.rerender(<MermaidBlock source="new" />);
  expect(await screen.findByText('정상 도식')).toBeVisible();
  await act(async () => resolve({ svg: '<svg viewBox="0 0 100 100"><text>오래된 도식</text></svg>' }));
  expect(screen.queryByText('오래된 도식')).toBeNull();
});

it('25~200% 확대·축소·초기화와 원문 열람을 제공한다', async () => {
  const view = render(<MermaidBlock source={'flowchart LR\nA-->B'} />);
  await screen.findByText('정상 도식');
  const zoomIn = screen.getByRole('button', { name: '다이어그램 확대' });
  const zoomOut = screen.getByRole('button', { name: '다이어그램 축소' });
  for (let i = 0; i < 10; i++) fireEvent.click(zoomIn);
  expect(screen.getByText('200%')).toBeVisible();
  expect(zoomIn).toBeDisabled();
  expect(view.container.querySelector('.mermaid-canvas')).toHaveStyle({ width: '1600px', height: '1200px' });
  for (let i = 0; i < 10; i++) fireEvent.click(zoomOut);
  expect(screen.getByText('25%')).toBeVisible();
  expect(zoomOut).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '다이어그램 배율 초기화' }));
  expect(screen.getByText('100%')).toBeVisible();
  fireEvent.click(screen.getByText('다이어그램 원문'));
  expect(screen.getByText('flowchart LR A-->B')).toBeVisible();
});
