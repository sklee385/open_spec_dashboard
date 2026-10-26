import { Children, isValidElement, useState } from 'react';
import type { ReactNode } from 'react';
import { MarkdownDocument } from './MarkdownDocument';
import { useI18n } from '@/i18n/context';
import './WorkContent.css';

const languages: Record<string, string> = { ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python', sh: 'bash', ps1: 'powershell', yml: 'yaml', md: 'markdown', txt: 'text' };

export function fileLanguage(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase() || 'text';
  return languages[extension] || extension;
}

function formattedCode(text: string, language: string) {
  if (language === 'json') {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* Incomplete streamed JSON stays intact. */ }
  }
  return text;
}

function tokens(text: string, language: string): ReactNode {
  if (['text', 'plaintext', 'output'].includes(language)) return text;
  // Render tokens as React text nodes: source content never becomes executable HTML.
  const pattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|\b(true|false|null|undefined|const|let|var|function|return|if|else|import|from|export|async|await|class|new|throw|try|catch|def|print|public|private)\b|\b(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const offset = match.index!;
    if (offset > cursor) parts.push(text.slice(cursor, offset));
    const kind = match[1] ? (language === 'json' && /^\s*:/.test(text.slice(offset + match[0].length)) ? 'key' : 'string') : match[2] ? 'comment' : match[3] ? 'keyword' : 'number';
    parts.push(<span className={`syntax-${kind}`} key={offset}>{match[0]}</span>);
    cursor = offset + match[0].length;
  }
  parts.push(text.slice(cursor));
  return parts;
}

export function CodeBlock({ text, language = 'text' }: { text: string; language?: string }) {
  const { t } = useI18n();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const name = languages[language.toLowerCase()] || language.toLowerCase();
  const code = formattedCode(text, name);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopyState('copied'); }
    catch { setCopyState('failed'); }
  };
  return <div className="work-code-block">
    <div className="work-code-toolbar"><span>{name}</span><button type="button" aria-label={t('workContent.copy')} onClick={() => void copy()}>{t('workContent.copy')}</button>
      <span role="status">{copyState === 'copied' ? t('workContent.copied') : copyState === 'failed' ? t('workContent.copyFailed') : ''}</span>
    </div>
    <pre><code className={`language-${name}`}>{tokens(code, name)}</code></pre>
  </div>;
}

export function JsonBlock({ value }: { value: unknown }) {
  return <CodeBlock language="json" text={JSON.stringify(value, null, 2) ?? 'null'} />;
}

export function MarkdownContent({ text }: { text: string }) {
  // Tool output and replies sometimes contain JSON without a fenced code block.
  if (/^\s*[{[]/.test(text)) {
    try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object') return <JsonBlock value={value} />; } catch { /* Ordinary Markdown or an incomplete stream. */ }
  }
  return <MarkdownDocument components={{
    pre({ children }) {
      const child = Children.toArray(children)[0];
      if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
        const language = /language-([^\s]+)/.exec(child.props.className || '')?.[1] || 'text';
        return <CodeBlock language={language} text={String(child.props.children ?? '').replace(/\n$/, '')} />;
      }
      return <pre>{children}</pre>;
    },
  }} text={text} />;
}
