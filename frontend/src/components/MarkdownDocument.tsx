import { Children, isValidElement, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidBlock } from './MermaidBlock';
import { useI18n } from '@/i18n/context';
import './MarkdownDocument.css';

function documentUrl(value: string, image: boolean) {
  const url = value.trim();
  if (!url || [...url].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === '\\')) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (!image) return /^(mailto:|#)/i.test(url) ? url : '';
  // Relative addresses resolve against the app, never the Markdown file's directory.
  return !url.startsWith('//') && !/^[^/?#]*:/.test(url) ? url : '';
}

function DocumentImage({ src, alt = '', title }: { src?: string; alt?: string; title?: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  if (!src) return <span className="markdown-image-error">{t('markdown.imageBlocked')}: {alt}</span>;
  if (failed) return <span role="status" className="markdown-image-error">{t('markdown.imageFailed')}: {alt}</span>;
  return <img src={src} alt={alt} title={title} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export function MarkdownDocument({ text, components }: { text: string; components?: Pick<Components, 'li' | 'pre'> }) {
  const { t } = useI18n();
  return <div className="markdown-document prose dark:prose-invert">
    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) => documentUrl(url, key === 'src')}
      components={{
        table: ({ children }) => <div className="markdown-scroll" role="region" aria-label={t('markdown.tableScroll')} tabIndex={0}><table>{children}</table></div>,
        pre: ({ children }) => {
          const child = Children.toArray(children)[0];
          if (isValidElement<{ className?: string; children?: ReactNode }>(child)
            && child.props.className?.split(/\s+/).includes('language-mermaid')) {
            return <MermaidBlock source={String(child.props.children ?? '').replace(/\n$/, '')} />;
          }
          return <pre className="markdown-scroll" tabIndex={0}>{children}</pre>;
        },
        a: ({ href, children, title }) => href
          ? <a href={href} title={title} rel="noopener noreferrer">{children}</a>
          : <span>{children}</span>,
        img: ({ src, alt, title }) => <DocumentImage key={src} src={typeof src === 'string' ? src : ''} alt={alt} title={title} />,
        ...components,
      }}>{text}</ReactMarkdown>
  </div>;
}
