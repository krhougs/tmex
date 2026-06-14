import { cn } from '@/lib/utils';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import '@/components/code-viewer/hljs-terminal-theme.css';
import { MermaidBlock } from './mermaid-block';

/** 简易 posix 路径规范化，处理 './' '../' 段 */
function normalizePosix(path: string): string {
  const isAbsolute = path.startsWith('/');
  const segments = path.split('/');
  const result: string[] = [];

  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (result.length > 0 && result[result.length - 1] !== '..') {
        result.pop();
      } else if (!isAbsolute) {
        result.push('..');
      }
      continue;
    }
    result.push(segment);
  }

  const joined = result.join('/');
  return isAbsolute ? `/${joined}` : joined;
}

/** 解析图片 src：外链/data 原样；绝对/相对路径转 /api/files/raw */
export function resolveImgSrc(src: string, basePath: string): string {
  if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) {
    return src;
  }
  const toRawUrl = (absPath: string): string =>
    `/api/files/raw?path=${encodeURIComponent(absPath)}`;

  if (src.startsWith('/')) {
    return toRawUrl(normalizePosix(src));
  }

  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
  const resolved = normalizePosix(`${base}${src}`);
  return toRawUrl(resolved);
}

function buildComponents(basePath: string): Components {
  return {
    a: ({ node: _node, ...props }) => (
      <a
        {...props}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2 break-all"
      />
    ),
    img: ({ node: _node, src, alt, ...props }) => (
      <img
        {...props}
        src={typeof src === 'string' ? resolveImgSrc(src, basePath) : src}
        alt={alt ?? ''}
        className="max-w-full rounded"
      />
    ),
    pre: ({ node: _node, ...props }) => (
      <pre
        {...props}
        className="bg-muted my-2 overflow-x-auto rounded-md p-3 font-mono text-[13px] leading-relaxed"
      />
    ),
    code: ({ node: _node, className, children, ...props }) => {
      const lang = /language-([\w-]+)/.exec(className ?? '')?.[1];
      if (lang === 'mermaid') {
        return <MermaidBlock code={String(children).replace(/\n$/, '')} />;
      }
      // fenced 代码块（rehype-highlight 会附加 hljs / language-* class），
      // inline code 没有 language-* 也不会被 hljs 处理。
      if (lang) {
        return (
          <code {...props} className={cn('font-mono text-[13px]', className)}>
            {children}
          </code>
        );
      }
      return (
        <code {...props} className={cn('bg-muted rounded px-1.5 py-0.5 font-mono text-[0.85em]')}>
          {children}
        </code>
      );
    },
    h1: ({ node: _node, ...props }) => (
      <h1 {...props} className="mt-4 mb-2 text-xl font-semibold first:mt-0" />
    ),
    h2: ({ node: _node, ...props }) => (
      <h2 {...props} className="border-border mt-4 mb-2 border-b pb-1 text-lg font-semibold" />
    ),
    h3: ({ node: _node, ...props }) => (
      <h3 {...props} className="mt-3 mb-1.5 text-base font-semibold" />
    ),
    h4: ({ node: _node, ...props }) => (
      <h4 {...props} className="mt-3 mb-1.5 text-sm font-semibold" />
    ),
    p: ({ node: _node, ...props }) => <p {...props} className="my-2 leading-relaxed" />,
    ul: ({ node: _node, ...props }) => <ul {...props} className="my-2 list-disc pl-6" />,
    ol: ({ node: _node, ...props }) => <ol {...props} className="my-2 list-decimal pl-6" />,
    li: ({ node: _node, ...props }) => <li {...props} className="my-0.5" />,
    blockquote: ({ node: _node, ...props }) => (
      <blockquote
        {...props}
        className="border-border text-muted-foreground my-2 border-l-2 pl-3 italic"
      />
    ),
    hr: ({ node: _node, ...props }) => <hr {...props} className="border-border my-4" />,
    table: ({ node: _node, ...props }) => (
      <div className="my-2 overflow-x-auto">
        <table {...props} className="border-border w-full border-collapse border text-sm" />
      </div>
    ),
    thead: ({ node: _node, ...props }) => <thead {...props} className="bg-muted" />,
    th: ({ node: _node, ...props }) => (
      <th {...props} className="border-border border px-3 py-1.5 text-left font-semibold" />
    ),
    td: ({ node: _node, ...props }) => (
      <td {...props} className="border-border border px-3 py-1.5" />
    ),
  };
}

export function MarkdownPreview({
  source,
  basePath,
  className,
}: {
  source: string;
  basePath: string;
  className?: string;
}) {
  const components = buildComponents(basePath);
  return (
    <div className={cn('min-w-0 text-sm', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: true }]]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
