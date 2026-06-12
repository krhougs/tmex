// 流式 markdown 渲染：按 fence 感知的双换行分块，块级 memo，
// 流式追加时只有最后一块重新 parse，避免长文本整体重渲染。

import { cn } from '@/lib/utils';
import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 在代码块围栏外的空行处分块（围栏内的双换行不是块边界） */
export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const pushCurrent = (): void => {
    const block = current.join('\n');
    if (block.trim()) {
      blocks.push(block);
    }
    current = [];
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && line.trim() === '') {
      pushCurrent();
      continue;
    }
    current.push(line);
  }
  pushCurrent();

  return blocks;
}

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 break-all"
    />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      {...props}
      className="bg-muted overflow-x-auto rounded-md p-2 font-mono text-xs leading-relaxed"
    />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code {...props} className={cn('bg-muted rounded px-1 font-mono text-xs', className)} />
  ),
  ul: ({ node: _node, ...props }) => <ul {...props} className="list-disc pl-5" />,
  ol: ({ node: _node, ...props }) => <ol {...props} className="list-decimal pl-5" />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote {...props} className="border-border text-muted-foreground border-l-2 pl-2" />
  ),
  h1: ({ node: _node, ...props }) => <h1 {...props} className="text-base font-semibold" />,
  h2: ({ node: _node, ...props }) => <h2 {...props} className="text-sm font-semibold" />,
  h3: ({ node: _node, ...props }) => <h3 {...props} className="text-sm font-semibold" />,
  table: ({ node: _node, ...props }) => (
    <div className="overflow-x-auto">
      <table {...props} className="border-border w-full border-collapse border text-xs" />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th {...props} className="border-border bg-muted border px-2 py-1 text-left" />
  ),
  td: ({ node: _node, ...props }) => <td {...props} className="border-border border px-2 py-1" />,
};

const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
});

export function StreamingMarkdown({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);

  return (
    <div className={cn('flex min-w-0 flex-col gap-2 text-sm leading-relaxed', className)}>
      {blocks.map((block, index) => (
        // 块序号作 key：流式追加时前面的块内容不变，memo 直接命中
        // biome-ignore lint/suspicious/noArrayIndexKey: 块顺序只会尾部追加
        <MarkdownBlock key={index} content={block} />
      ))}
      {streaming && (
        <span
          data-testid="agent-streaming-cursor"
          className="bg-foreground inline-block h-4 w-2 animate-pulse self-start"
        />
      )}
    </div>
  );
}
