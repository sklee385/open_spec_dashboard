import { Children, isValidElement, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidBlock } from './MermaidBlock';
import './MarkdownDocument.css';

function linkAllowed(url: string) { return /^(https?:\/\/|mailto:|#)/i.test(url); }
function imageAllowed(url: string) { return /^(https?:\/\/)/i.test(url) || (!/^[\w+.-]+:|^\/\//.test(url) && !url.includes('\\')); }
function DocumentImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || !imageAllowed(src)) return <span>{alt}</span>;
  return failed ? <span role="status">이미지를 불러올 수 없습니다: {alt}</span> : <img src={src} alt={alt || ''} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export function MarkdownDocument({ text, components }: { text: string; components?: Components }) {
  return <div className="markdown-document"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
    urlTransform={(url, key) => (key === 'src' ? imageAllowed(url) : linkAllowed(url)) ? url : ''}
    components={{
      a: ({ href, children }) => href && linkAllowed(href) ? <a href={href} rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
      img: ({ src, alt }) => <DocumentImage key={typeof src === 'string' ? src : ''} src={typeof src === 'string' ? src : undefined} alt={alt} />,
      table: ({ children, ...props }) => <div className="markdown-scroll"><table {...props}>{children}</table></div>,
      pre: ({ children }) => {
        const child = Children.toArray(children)[0];
        if (isValidElement<{ className?: string; children?: ReactNode }>(child) && child.props.className === 'language-mermaid') {
          return <MermaidBlock source={String(child.props.children || '').replace(/\n$/, '')} />;
        }
        return <div className="markdown-scroll"><pre>{children}</pre></div>;
      },
      ...components,
    }}>{text}</ReactMarkdown></div>;
}
