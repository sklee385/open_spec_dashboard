import DOMPurify from 'dompurify';

const tags = ['svg', 'g', 'defs', 'marker', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc', 'clipPath'];
const attributes = ['id', 'class', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'dx', 'dy', 'marker-start', 'marker-mid', 'marker-end', 'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'clip-path', 'preserveAspectRatio', 'xmlns', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby'];

export function sanitizeDiagram(svg: string) {
  const clean = DOMPurify.sanitize(svg, { ALLOWED_TAGS: tags, ALLOWED_ATTR: attributes, ALLOW_DATA_ATTR: false });
  const doc = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || doc.querySelector('parsererror')) throw new Error('SVG 형식 오류');
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...element.attributes]) {
      if (['fill', 'stroke', 'marker-start', 'marker-mid', 'marker-end', 'clip-path'].includes(attr.name)
        && !/^(?:none|currentColor|transparent|[a-zA-Z]+|#[\da-fA-F]{3,8}|url\(#[\w-]+\))$/.test(attr.value)) element.removeAttribute(attr.name);
    }
    // Mermaid's generated stylesheet is deliberately removed; retain readable geometry.
    if (['rect', 'circle', 'ellipse', 'polygon', 'path', 'line', 'polyline'].includes(element.localName)) {
      if (!element.hasAttribute('fill')) element.setAttribute('fill', element.closest('marker') ? 'currentColor' : 'none');
      if (!element.hasAttribute('stroke') || element.getAttribute('stroke') === 'none') element.setAttribute('stroke', 'currentColor');
      if (element.classList.contains('messageLine1')) element.setAttribute('stroke-dasharray', '4 3');
    }
    if (['text', 'tspan'].includes(element.localName)) element.setAttribute('fill', 'currentColor');
  }
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const width = box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 ? box[2] : 800;
  const height = box?.length === 4 && box.every(Number.isFinite) && box[3] > 0 ? box[3] : 600;
  root.setAttribute('width', '100%');
  root.setAttribute('height', '100%');
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', 'Mermaid 다이어그램');
  return { svg: new XMLSerializer().serializeToString(root), width, height };
}

let renderer: Promise<typeof import('mermaid')> | undefined;

export async function renderDiagram(id: string, source: string) {
  renderer ??= import('mermaid').catch(error => { renderer = undefined; throw error; });
  const { default: mermaid } = await renderer;
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
    maxTextSize: 65536, suppressErrorRendering: true,
    secure: ['secure', 'securityLevel', 'startOnLoad', 'htmlLabels', 'maxTextSize', 'suppressErrorRendering', 'themeCSS'],
  });
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
  document.body.append(host);
  try {
    const { svg } = await mermaid.render(id, source, host);
    return sanitizeDiagram(svg);
  } finally { host.remove(); }
}
