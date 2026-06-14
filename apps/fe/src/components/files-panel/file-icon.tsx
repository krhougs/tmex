import type { FileCategory, FileEntryType } from '@tmex/shared';
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  type LucideIcon,
} from 'lucide-react';

const JSON_EXTS = new Set(['json', 'jsonc', 'json5']);

// 按类别（+ 少量扩展名细化）映射到 lucide 图标。受支持的类型有专属图标，便于一眼识别。
export function fileIconFor(
  entry: { category: FileCategory; name: string; type: FileEntryType },
  opts?: { expanded?: boolean }
): LucideIcon {
  if (entry.type === 'dir' || entry.category === 'directory') {
    return opts?.expanded ? FolderOpen : Folder;
  }

  const ext = entry.name.toLowerCase().split('.').pop() ?? '';
  switch (entry.category) {
    case 'code':
      return JSON_EXTS.has(ext) ? FileJson : FileCode;
    case 'markdown':
      return FileText;
    case 'image':
      return FileImage;
    case 'pdf':
      return FileText;
    case 'archive':
      return FileArchive;
    case 'audio':
      return FileAudio;
    case 'video':
      return FileVideo;
    case 'text':
      return FileText;
    default:
      return File;
  }
}

// 受支持类型给一点克制的着色，未支持/二进制保持 muted。
export function fileIconColor(category: FileCategory): string {
  switch (category) {
    case 'directory':
      return 'text-muted-foreground';
    case 'code':
      return 'text-blue-500/80 dark:text-blue-400/80';
    case 'markdown':
      return 'text-foreground/70';
    case 'image':
      return 'text-emerald-500/80 dark:text-emerald-400/80';
    case 'pdf':
      return 'text-red-500/70 dark:text-red-400/70';
    case 'archive':
      return 'text-amber-500/80 dark:text-amber-400/80';
    case 'audio':
      return 'text-purple-500/70 dark:text-purple-400/70';
    case 'video':
      return 'text-pink-500/70 dark:text-pink-400/70';
    default:
      return 'text-muted-foreground';
  }
}
