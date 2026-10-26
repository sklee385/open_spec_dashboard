import { screen, fireEvent } from '@testing-library/react';
import { render } from '../test/render';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownDocument } from './MarkdownDocument';
import example from '../../../docs/examples/markdown-viewer.md?raw';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 200 100"><text>연결된 도식</text></svg>' }) } }));

describe('MarkdownDocument', () => {
  it('사용자 예제 문서의 표·체크리스트·지원 문법과 테스트가 대응한다', async () => {
    const { container } = render(<MarkdownDocument text={example} />);
    expect(screen.getByRole('heading', { name: 'Markdown 예제' })).toBeVisible();
    expect(screen.getAllByRole('columnheader')).toHaveLength(4);
    expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
    expect(container.querySelector('code.language-unknown')).toHaveTextContent('알 수 없는 언어는 <원문 코드> 그대로 표시합니다.');
    expect(await screen.findAllByRole('img', { name: 'Mermaid 다이어그램' })).toHaveLength(2);
  });
  it('mermaid 코드만 도식으로 표시하고 다른 언어는 원문 코드로 유지한다', async () => {
    const { container } = render(<MarkdownDocument text={'```mermaid\nflowchart LR\nA-->B\n```\n\n```unknown\n원문 <tag>\n```'} />);
    expect(await screen.findByText('연결된 도식')).toBeVisible();
    expect(container.querySelector('code.language-unknown')).toHaveTextContent('원문 <tag>');
    expect(container.querySelector('pre > section')).toBeNull();
  });
  it('기본 문법과 GFM 구조·정렬·읽기 전용 체크 상태를 유지한다', () => {
    const { container } = render(<MarkdownDocument text={'# 제목\n\n> 인용\n\n1. 순서\n\n- 항목\n- [x] 완료\n- [ ] 대기\n\n~~취소~~ `코드`\n\n---\n\n| 왼쪽 | 가운데 | 오른쪽 |\n| :--- | :---: | ---: |\n| 가 | 나 | 다 |\n\n```js\nconst x = 1;\n```\n\nhttps://example.com'} />);
    expect(screen.getByRole('heading', { name: '제목' })).toBeVisible();
    expect(container.querySelector('blockquote')).toHaveTextContent('인용');
    expect(container.querySelector('ol li')).toHaveTextContent('순서');
    expect(container.querySelector('del')).toHaveTextContent('취소');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(screen.getAllByRole('columnheader').map(cell => cell.getAttribute('style'))).toEqual(['text-align: left;', 'text-align: center;', 'text-align: right;']);
    const checks = screen.getAllByRole('checkbox');
    expect(checks[0]).toBeChecked();
    expect(checks[1]).not.toBeChecked();
    checks.forEach(check => expect(check).toBeDisabled());
    expect(container.querySelector('pre code')).toHaveTextContent('const x = 1;');
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com');
    expect(screen.getByRole('table').parentElement).toHaveClass('markdown-scroll');
  });

  it('링크 정책을 적용하고 원문 HTML을 실행하지 않는다', () => {
    const { container } = render(<MarkdownDocument text={'[웹](https://example.com) [메일](mailto:dev@example.com) [앵커](#section) [상대](./local.md) [위험](javascript:alert%281%29) [파일](file:///secret) [데이터](data:text/html,hello)\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">'} />);
    expect(screen.getByRole('link', { name: '웹' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: '메일' })).toHaveAttribute('href', 'mailto:dev@example.com');
    expect(screen.getByRole('link', { name: '앵커' })).toHaveAttribute('href', '#section');
    for (const name of ['상대', '위험', '파일', '데이터']) expect(screen.queryByRole('link', { name })).toBeNull();
    expect(container.querySelector('script, img')).toBeNull();
  });

  it('안전한 이미지에 대체 텍스트와 referrer 제한, 실패 안내를 제공한다', () => {
    render(<MarkdownDocument text={'![설명](https://example.com/image.png)\n\n![상대](./image.png)\n\n![차단](data:image/png;base64,abcd)'} />);
    const image = screen.getByRole('img', { name: '설명' });
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.getByRole('img', { name: '상대' })).toHaveAttribute('src', './image.png');
    expect(screen.queryByRole('img', { name: '차단' })).toBeNull();
    fireEvent.error(image);
    expect(screen.getByText(/이미지를 불러올 수 없습니다.*설명/)).toBeVisible();
  });
});
