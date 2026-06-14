// 代码/纯文本查看器：highlight.js 高亮 + 终端 seoul256 配色（hljs-terminal-theme.css）。
// 左侧行号栏 + 右侧可横向滚动代码区，font-mono 与终端共享字体栈。

import { cn } from '@/lib/utils';
// 只引入常用语言子集（~37 种），避免 full build（~190 种语言，约 1MB）拖大 FilePage chunk。
// 子集已覆盖 ts/js/py/json/css/xml/bash/yaml/sql/go/rust/java/c/cpp/markdown/makefile 等；
// 未覆盖的（dockerfile/dart/scala 等）回退到 highlightAuto，不影响可读性。
import hljs from 'highlight.js/lib/common';
import { useMemo } from 'react';
import './hljs-terminal-theme.css';

// 文件扩展名 -> highlight.js 语言名映射，覆盖常见语言。
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  cts: 'typescript',
  mts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  scala: 'scala',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  jsonc: 'json',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  dart: 'dart',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveLanguage(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  // 无扩展名的特例文件（Dockerfile / Makefile）
  if (lower === 'dockerfile' || lower.endsWith('.dockerfile')) {
    return 'dockerfile';
  }
  if (lower === 'makefile') {
    return 'makefile';
  }
  const dot = lower.lastIndexOf('.');
  if (dot < 0) {
    return undefined;
  }
  return EXT_TO_LANG[lower.slice(dot + 1)];
}

function highlightCode(code: string, fileName: string): string {
  const lang = resolveLanguage(fileName);
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

export interface CodeViewerProps {
  code: string;
  fileName: string;
  className?: string;
}

export function CodeViewer({ code, fileName, className }: CodeViewerProps) {
  const html = useMemo(() => highlightCode(code, fileName), [code, fileName]);
  const lineCount = useMemo(() => {
    const n = code.split('\n').length;
    // 末尾换行会多出一个空行，行号栏与代码区都按同样的行数渲染即可对齐。
    return n;
  }, [code]);

  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'),
    [lineCount]
  );

  return (
    <div
      className={cn(
        'hljs flex w-full overflow-x-auto font-mono text-[13px] leading-[1.5] [-webkit-overflow-scrolling:touch]',
        className
      )}
    >
      <pre
        aria-hidden="true"
        className="m-0 shrink-0 select-none border-r border-current/10 px-3 py-2 text-right opacity-40"
        style={{ whiteSpace: 'pre' }}
      >
        {lineNumbers}
      </pre>
      <pre className="m-0 min-w-0 flex-1 px-3 py-2" style={{ whiteSpace: 'pre' }}>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js 输出，内容已被其转义 */}
        <code className="hljs bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
