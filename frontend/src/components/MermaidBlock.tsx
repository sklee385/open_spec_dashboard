import { useEffect, useId, useState } from 'react';
import DOMPurify from 'dompurify';
let rendererModule: Promise<typeof import('mermaid')> | undefined;

function cleanSvg(input: string) {
  const safe = DOMPurify.sanitize(input, {
    ALLOWED_TAGS: ['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'marker', 'clipPath', 'title', 'desc'],
    ALLOWED_ATTR: ['xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'rx', 'ry', 'r', 'd', 'points', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'fill-opacity', 'transform', 'text-anchor', 'dominant-baseline', 'font-size', 'font-family', 'font-weight', 'id', 'class', 'marker-end', 'marker-start', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'clip-path'],
  });
  const document = new DOMParser().parseFromString(safe, 'image/svg+xml');
  const svg = document.documentElement;
  if (svg.localName !== 'svg' || document.querySelector('parsererror')) throw new Error('Invalid SVG');
  for (const node of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    for (const attribute of Array.from(node.attributes)) {
      if (/url\s*\(/i.test(attribute.value) && !/^url\(\s*#[\w:.-]+\s*\)$/.test(attribute.value)) node.removeAttribute(attribute.name);
    }
  }
  // Mermaid relies on internal CSS. Supply safe defaults after removing that CSS.
  for (const shape of svg.querySelectorAll('path, line, polyline, polygon, rect, circle, ellipse')) {
    if (!shape.hasAttribute('fill')) shape.setAttribute('fill', shape.closest('marker') ? 'currentColor' : 'none');
    if (!shape.hasAttribute('stroke')) shape.setAttribute('stroke', 'currentColor');
  }
  for (const text of svg.querySelectorAll('text, tspan')) if (!text.hasAttribute('fill')) text.setAttribute('fill', 'currentColor');
  const bounds = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(Number);
  const width = bounds?.[2] || Number.parseFloat(svg.getAttribute('width') || '') || 800;
  const height = bounds?.[3] || Number.parseFloat(svg.getAttribute('height') || '') || 600;
  return { svg: svg.outerHTML, width: Math.min(Math.max(width, 1), 10000), height: Math.min(Math.max(height, 1), 10000) };
}

export function MermaidBlock({ source }: { source: string }) {
  const id = useId().replace(/[^a-z0-9]/gi, '');
  const [result, setResult] = useState<ReturnType<typeof cleanSvg> | null>(null), [error, setError] = useState('');
  const [zoom, setZoom] = useState(100);
  useEffect(() => {
    let current = true;
    setResult(null); setError(''); setZoom(100);
    if (new TextEncoder().encode(source).byteLength > 65536) { setError('다이어그램은 UTF-8 64KiB까지 표시할 수 있습니다.'); return; }
    void (async () => {
      try {
        const { default: mermaid } = await (rendererModule ??= import('mermaid'));
        if (!current) return;
        mermaid.initialize({ securityLevel: 'strict', htmlLabels: false, startOnLoad: false, suppressErrorRendering: true, flowchart: { htmlLabels: false } });
        const rendered = await mermaid.render(`diagram-${id}-${crypto.randomUUID()}`, source);
        if (current) setResult(cleanSvg(rendered.svg));
      } catch { if (current) setError('다이어그램을 표시할 수 없습니다. 아래 원문을 확인해 주세요.'); }
    })();
    return () => { current = false; };
  }, [source, id]);
  return <section className="mermaid-block">
    {error ? <><p role="alert">{error}</p><pre><code>{source}</code></pre></> : <>
      <div className="mermaid-toolbar"><button type="button" aria-label="다이어그램 축소" disabled={zoom <= 25} onClick={() => setZoom(value => Math.max(25, value - 25))}>−</button>
        <span>{zoom}%</span><button type="button" aria-label="다이어그램 확대" disabled={zoom >= 200} onClick={() => setZoom(value => Math.min(200, value + 25))}>+</button>
        <button type="button" aria-label="다이어그램 배율 초기화" onClick={() => setZoom(100)}>초기화</button></div>
      {result ? <div className="markdown-scroll"><div className="mermaid-canvas" style={{ width: result.width * zoom / 100, height: result.height * zoom / 100 }} dangerouslySetInnerHTML={{ __html: result.svg }} /></div> : <p role="status">다이어그램을 불러오는 중…</p>}
      <details><summary>다이어그램 원문</summary><pre><code>{source}</code></pre></details>
    </>}
  </section>;
}
