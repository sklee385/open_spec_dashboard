import { Component, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { renderDiagram } from '../lib/mermaidRenderer';
import { useI18n } from '@/i18n/context';

let nextRender = 0;
type Diagram = Awaited<ReturnType<typeof renderDiagram>>;

function Source({ source, open = false }: { source: string; open?: boolean }) {
  const { t } = useI18n();
  return <details open={open}><summary>{t('markdown.diagramSource')}</summary><pre className="markdown-scroll" tabIndex={0}><code>{source}</code></pre></details>;
}

function DiagramFailure({ source }: { source: string }) {
  const { t } = useI18n();
  return <div role="alert">{t('markdown.diagramError')}<Source source={source} open /></div>;
}

class BlockBoundary extends Component<{ source: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <DiagramFailure source={this.props.source} /> : this.props.children;
  }
}

function DiagramContent({ source }: { source: string }) {
  const { t } = useI18n();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const generation = useRef(0);
  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(100);
  const oversized = new TextEncoder().encode(source).length > 65536;
  useEffect(() => {
    if (oversized) return;
    const current = ++generation.current;
    let active = true;
    void renderDiagram(`mermaid-${id}-${++nextRender}`, source).then(result => {
      if (active && generation.current === current) setDiagram(result);
    }).catch(() => {
      if (active && generation.current === current) setError(true);
    });
    return () => { active = false; };
  }, [id, source, oversized]);
  const failure = oversized ? t('markdown.diagramLimit') : error ? t('markdown.diagramError') : '';
  return <section className="mermaid-block" aria-label={t('markdown.diagram')}>
    {failure ? <p role="alert">{failure}</p> : !diagram ? <p role="status">{t('markdown.diagramLoading')}</p> : <>
      <div className="mermaid-toolbar">
        <button type="button" aria-label={t('markdown.zoomOut')} disabled={zoom <= 25} onClick={() => setZoom(value => Math.max(25, value - 25))}>−</button>
        <output aria-live="polite">{zoom}%</output>
        <button type="button" aria-label={t('markdown.zoomIn')} disabled={zoom >= 200} onClick={() => setZoom(value => Math.min(200, value + 25))}>+</button>
        <button type="button" aria-label={t('markdown.zoomReset')} onClick={() => setZoom(100)}>{t('markdown.reset')}</button>
      </div>
      <div className="mermaid-viewport" role="region" aria-label={t('markdown.diagramScroll')} tabIndex={0}>
        <div className="mermaid-canvas" style={{ width: diagram.width * zoom / 100, height: diagram.height * zoom / 100 }} dangerouslySetInnerHTML={{ __html: diagram.svg }} />
      </div>
    </>}
    <Source source={source} open={!!failure} />
  </section>;
}

export function MermaidBlock({ source }: { source: string }) {
  return <BlockBoundary key={source} source={source}><DiagramContent source={source} /></BlockBoundary>;
}
