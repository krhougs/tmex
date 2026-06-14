import { extname } from 'node:path';
import type { FileCategory } from '@tmex/shared';

export const MAX_ENTRIES = 2000;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2MB

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
const PDF_EXTS = new Set(['pdf']);
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v']);
const TEXT_EXTS = new Set(['txt', 'text', 'log', 'csv', 'tsv', 'rtf']);
// prettier-ignore
const CODE_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'json5',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'xml',
  'vue',
  'svelte',
  'astro',
  'py',
  'pyi',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cpp',
  'cc',
  'cxx',
  'hpp',
  'hh',
  'cs',
  'php',
  'swift',
  'm',
  'mm',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'toml',
  'yaml',
  'yml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'gradle',
  'lua',
  'r',
  'dart',
  'scala',
  'clj',
  'cljs',
  'ex',
  'exs',
  'erl',
  'hs',
  'ml',
  'mli',
  'pl',
  'pm',
  'vim',
  'lock',
  'tf',
  'tfvars',
  'proto',
  'graphql',
  'gql',
  'prisma',
  'dockerfile',
  'makefile',
  'cmake',
  'nix',
  'zig',
  'd',
  'jl',
  'groovy',
  'patch',
  'diff',
]);
const KNOWN_NOEXT = new Set([
  'makefile',
  'dockerfile',
  'license',
  'readme',
  'changelog',
  'authors',
  'copying',
  'notice',
  'procfile',
  'gemfile',
  'rakefile',
  'brewfile',
  'caddyfile',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.env',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
  '.dockerignore',
  '.zshrc',
  '.bashrc',
  '.profile',
]);

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

function extOf(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

export function categorize(name: string): FileCategory {
  const lower = name.toLowerCase();
  const ext = extOf(lower);
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (CODE_EXTS.has(ext)) return 'code';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (!ext && KNOWN_NOEXT.has(lower)) return 'code';
  return 'other';
}

export function mimeOf(name: string): string | null {
  return MIME_MAP[extOf(name)] ?? null;
}

export function isTextCategory(category: FileCategory): boolean {
  return category === 'code' || category === 'markdown' || category === 'text';
}
