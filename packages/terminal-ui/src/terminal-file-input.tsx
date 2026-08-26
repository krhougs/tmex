import { formatBytes, uploadFileChunked } from '@tmex/api-client';
import { PASTE_IMAGE_MAX_BYTES, TERMINAL_PASTE_MAX_BYTES } from '@tmex/shared';
import type { HostFileReference, RuntimeCore } from '@tmex/stores';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { HostLayerElement } from '@tmex/ui/host-layer';
import { FileUp, ShieldAlert } from 'lucide-react';
import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { startTransferToast } from './components/transfer-toast';

export type TerminalFilePasteTarget = {
  rootId: string;
  directory: string;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

type BrowserFileSource = {
  kind: 'file' | 'clipboard-image';
  file: File;
};

type NativeFileSource = {
  kind: 'native-path';
  file: HostFileReference;
};

type TerminalFileSource = BrowserFileSource | NativeFileSource;

export type TerminalFileDropState = {
  count: number;
  mode: 'local' | 'upload';
};

export type TerminalFileRiskPrompt = {
  names: string[];
  totalCount: number;
};

const SAFE_IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
]);

const SAFE_TEXT_EXTENSIONS = new Set([
  'bash',
  'c',
  'cc',
  'cfg',
  'conf',
  'cpp',
  'css',
  'csv',
  'cts',
  'cxx',
  'diff',
  'env',
  'fish',
  'go',
  'gql',
  'graphql',
  'h',
  'hpp',
  'htm',
  'html',
  'hxx',
  'ini',
  'java',
  'js',
  'json',
  'json5',
  'jsonc',
  'jsx',
  'kt',
  'kts',
  'less',
  'log',
  'lock',
  'lua',
  'markdown',
  'md',
  'mjs',
  'mts',
  'patch',
  'php',
  'properties',
  'proto',
  'ps1',
  'py',
  'pyi',
  'rb',
  'rs',
  'rst',
  'sass',
  'scala',
  'scss',
  'sh',
  'sql',
  'svelte',
  'swift',
  'text',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

const SAFE_TEXT_NAMES = new Set([
  '.editorconfig',
  '.env',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.prettierignore',
  '.prettierrc',
  'cmakelists.txt',
  'dockerfile',
  'license',
  'makefile',
  'readme',
]);

const SAFE_TEXT_MIME_TYPES = new Set([
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/toml',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-sh',
  'application/x-yaml',
  'application/xhtml+xml',
  'application/xml',
  'application/yaml',
]);

export function resolveTerminalFilePasteTarget(
  currentPath: string | null | undefined,
  roots: readonly { id: string; path: string }[]
): TerminalFilePasteTarget | null {
  if (!currentPath) return null;
  const root = roots
    .filter(
      (candidate) =>
        currentPath === candidate.path ||
        currentPath.startsWith(candidate.path === '/' ? '/' : `${candidate.path}/`)
    )
    .sort((left, right) => right.path.length - left.path.length)[0];
  return root ? { rootId: root.id, directory: currentPath } : null;
}

export function pasteImageExtension(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}

export function quoteTerminalPath(path: string): string {
  return `'${path.split("'").join("'\\''")}'`;
}

function fileBasename(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

function fileExtension(name: string): string {
  const basename = fileBasename(name).toLowerCase();
  const dot = basename.lastIndexOf('.');
  return dot > 0 ? basename.slice(dot + 1) : '';
}

export function terminalFileNeedsSafetyConfirmation(name: string, mimeType = ''): boolean {
  const normalizedMime = mimeType.trim().toLowerCase().split(';', 1)[0] ?? '';
  if (normalizedMime.startsWith('image/') || normalizedMime.startsWith('text/')) return false;
  if (SAFE_TEXT_MIME_TYPES.has(normalizedMime)) return false;

  const basename = fileBasename(name).toLowerCase();
  if (
    SAFE_TEXT_NAMES.has(basename) ||
    basename.startsWith('.env.') ||
    basename.startsWith('dockerfile.') ||
    basename.startsWith('makefile.')
  ) {
    return false;
  }
  const extension = fileExtension(basename);
  return !SAFE_IMAGE_EXTENSIONS.has(extension) && !SAFE_TEXT_EXTENSIONS.has(extension);
}

export function resolveTerminalFileRoute(
  hasTrustedLocalPath: boolean,
  isLocalInstance: boolean
): 'local-path' | 'upload' {
  return hasTrustedLocalPath && isLocalInstance ? 'local-path' : 'upload';
}

function appendTerminalPath(directory: string, name: string): string {
  if (directory.endsWith('/') || directory.endsWith('\\')) return `${directory}${name}`;
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  return `${directory}${separator}${name}`;
}

function safeTransferName(name: string): string {
  const basename = fileBasename(name);
  const safe = Array.from(basename)
    .map((character) => (character <= '\u001f' || character === '\u007f' ? '_' : character))
    .join('')
    .trim();
  return safe || `paste-${Date.now()}`;
}

function sourceName(source: TerminalFileSource): string {
  return source.file.name;
}

function sourceMimeType(source: TerminalFileSource): string {
  return source.kind === 'native-path' ? '' : source.file.type;
}

function reportClipboardImageTooLarge(runtime: RuntimeCore, t: Translate, size: number): void {
  runtime.notifications.error(
    t('terminal.imagePasteTooLarge', {
      size: formatBytes(size),
      limit: formatBytes(PASTE_IMAGE_MAX_BYTES),
    })
  );
}

async function uploadTerminalFile(args: {
  source: TerminalFileSource;
  target: TerminalFilePasteTarget;
  runtime: RuntimeCore;
  t: Translate;
  controllers: Set<AbortController>;
}): Promise<string | null> {
  const { source, target, runtime, t, controllers } = args;
  if (source.kind === 'clipboard-image' && source.file.size > PASTE_IMAGE_MAX_BYTES) {
    reportClipboardImageTooLarge(runtime, t, source.file.size);
    return null;
  }

  const name = safeTransferName(sourceName(source));
  const controller = new AbortController();
  controllers.add(controller);
  const transfer = startTransferToast(name, 'upload', () => controller.abort());
  const progress = ({ loaded, total, pct }: { loaded: number; total: number; pct: number }) => {
    transfer.leg(1, {
      pct,
      detail: `${formatBytes(loaded)} / ${formatBytes(total)}`,
    });
  };

  try {
    const provider = runtime.terminalFileLinks;
    let uploaded: string;
    if (source.kind === 'native-path') {
      if (!provider?.uploadPath) throw new Error('native path upload is unavailable');
      uploaded = appendTerminalPath(target.directory, name);
      await provider.uploadPath(target.rootId, uploaded, source.file.path, {
        signal: controller.signal,
        onProgress: progress,
      });
      transfer.leg(1, { pct: 100, detail: formatBytes(source.file.size) });
      transfer.leg(2, { pct: 100, detail: formatBytes(source.file.size) });
    } else if (provider?.upload) {
      uploaded = appendTerminalPath(target.directory, name);
      await provider.upload(target.rootId, uploaded, source.file, {
        signal: controller.signal,
        onProgress: progress,
      });
      transfer.leg(1, { pct: 100, detail: formatBytes(source.file.size) });
      transfer.leg(2, { pct: 100, detail: formatBytes(source.file.size) });
    } else {
      const file =
        source.file.name === name
          ? source.file
          : new File([source.file], name, {
              type: source.file.type,
              lastModified: source.file.lastModified,
            });
      uploaded = await uploadFileChunked(
        target.rootId,
        target.directory,
        file,
        {
          kind: source.kind === 'clipboard-image' ? 'paste-image' : 'file',
          signal: controller.signal,
          onLeg: transfer.leg,
        },
        runtime.apiClient
      );
    }
    transfer.success(t('terminal.filePasteUploaded', { path: uploaded }));
    return uploaded;
  } catch (error) {
    if (controller.signal.aborted) {
      transfer.cancel();
    } else {
      transfer.fail(
        t('terminal.filePasteFailed', {
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }
    return null;
  } finally {
    controllers.delete(controller);
  }
}

async function processTerminalFiles(args: {
  sources: TerminalFileSource[];
  target: TerminalFilePasteTarget | null;
  runtime: RuntimeCore;
  t: Translate;
  controllers: Set<AbortController>;
  injectText(text: string): boolean | Promise<boolean>;
}): Promise<void> {
  const { sources, target, runtime, t, controllers, injectText } = args;
  const useDirectLocalPaths = runtime.terminalFileLinks?.isLocalInstance?.() === true;
  const needsUpload = sources.some(
    (source) =>
      resolveTerminalFileRoute(source.kind === 'native-path', useDirectLocalPaths) === 'upload'
  );
  if (needsUpload && !target) {
    runtime.notifications.error(t('terminal.filePasteNoRoot'));
    return;
  }

  const paths: string[] = [];
  for (const source of sources) {
    if (source.kind === 'native-path' && useDirectLocalPaths) {
      paths.push(source.file.path);
      continue;
    }
    if (!target) continue;
    const uploaded = await uploadTerminalFile({ source, target, runtime, t, controllers });
    if (uploaded) paths.push(uploaded);
  }
  if (paths.length === 0) return;

  const input = paths.map(quoteTerminalPath).join(' ');
  if (await injectText(input)) return;

  try {
    await runtime.host.writeClipboardText(paths.join('\n'));
    runtime.notifications.success(t('terminal.filePastePathCopied', { count: paths.length }));
  } catch {
    runtime.notifications.error(t('terminal.filePastePathCopyFailed'));
  }
}

function hasExternalFiles(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function pointInside(element: HTMLElement | null, position: { x: number; y: number }): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return (
    position.x >= rect.left &&
    position.x <= rect.right &&
    position.y >= rect.top &&
    position.y <= rect.bottom
  );
}

export function useTerminalFileInput(args: {
  runtime: RuntimeCore;
  t: Translate;
  enabled: boolean;
  target: TerminalFilePasteTarget | null;
  surfaceRef: RefObject<HTMLElement | null>;
  injectText(text: string): boolean | Promise<boolean>;
}) {
  const { runtime, t, enabled, target, surfaceRef, injectText } = args;
  const controllersRef = useRef(new Set<AbortController>());
  const dragDepthRef = useRef(0);
  const pendingBatchRef = useRef<{
    run(): void;
  } | null>(null);
  const [dropState, setDropState] = useState<TerminalFileDropState | null>(null);
  const [riskPrompt, setRiskPrompt] = useState<TerminalFileRiskPrompt | null>(null);

  useEffect(
    () => () => {
      for (const controller of controllersRef.current) controller.abort();
      controllersRef.current.clear();
    },
    []
  );

  useEffect(() => {
    if (enabled) return;
    dragDepthRef.current = 0;
    pendingBatchRef.current = null;
    setDropState(null);
    setRiskPrompt(null);
  }, [enabled]);

  const runSources = useCallback(
    (sources: TerminalFileSource[]) =>
      processTerminalFiles({
        sources,
        target,
        runtime,
        t,
        controllers: controllersRef.current,
        injectText,
      }),
    [injectText, runtime, t, target]
  );

  const requestSources = useCallback(
    (sources: TerminalFileSource[]) => {
      if (!enabled || sources.length === 0 || pendingBatchRef.current) return;
      const risky = sources.filter((source) =>
        terminalFileNeedsSafetyConfirmation(sourceName(source), sourceMimeType(source))
      );
      if (risky.length === 0) {
        void runSources(sources);
        return;
      }
      pendingBatchRef.current = {
        run: () => {
          void runSources(sources);
        },
      };
      setRiskPrompt({
        names: risky.map(sourceName),
        totalCount: sources.length,
      });
    },
    [enabled, runSources]
  );

  const confirmRisk = useCallback(() => {
    const batch = pendingBatchRef.current;
    pendingBatchRef.current = null;
    setRiskPrompt(null);
    batch?.run();
  }, []);

  const cancelRisk = useCallback(() => {
    pendingBatchRef.current = null;
    setRiskPrompt(null);
  }, []);

  const pasteText = useCallback(
    async (text: string) => {
      if (!text) return;
      const bytes = new TextEncoder().encode(text).byteLength;
      if (bytes > TERMINAL_PASTE_MAX_BYTES) {
        runtime.notifications.error(
          t('terminal.pasteTooLarge', {
            size: (bytes / (1024 * 1024)).toFixed(1),
            limit: TERMINAL_PASTE_MAX_BYTES / (1024 * 1024),
          })
        );
        return;
      }
      await injectText(text);
    },
    [injectText, runtime, t]
  );

  const handlePasteCapture = useCallback(
    (event: ReactClipboardEvent<HTMLElement>) => {
      if (!enabled) return;
      let files = Array.from(event.clipboardData.files);
      if (files.length === 0) {
        files = Array.from(event.clipboardData.items)
          .filter((item) => item.kind === 'file')
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
      }
      if (files.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        requestSources(files.map((file) => ({ kind: 'file', file })));
        return;
      }
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      void pasteText(text);
    },
    [enabled, pasteText, requestSources]
  );

  const pasteFromClipboard = useCallback(async () => {
    if (!enabled) return;
    try {
      const files = runtime.host.readClipboardFiles ? await runtime.host.readClipboardFiles() : [];
      if (files.length > 0) {
        requestSources(files.map((file) => ({ kind: 'native-path', file })));
        return;
      }
      const image = runtime.host.readClipboardImage
        ? await runtime.host.readClipboardImage().catch(() => null)
        : null;
      if (image) {
        if (!image.blob) {
          reportClipboardImageTooLarge(runtime, t, image.size);
        } else {
          const file = new File(
            [image.blob],
            `paste-${Date.now()}.${pasteImageExtension(image.mimeType)}`,
            { type: image.mimeType }
          );
          requestSources([{ kind: 'clipboard-image', file }]);
        }
        return;
      }
      await pasteText(await runtime.host.readClipboardText());
    } catch {
      runtime.notifications.error(t('terminal.pasteFailed'));
    }
  }, [enabled, pasteText, requestSources, runtime, t]);

  useEffect(() => {
    if (!enabled || !runtime.host.onFileDragDrop) return;
    return runtime.host.onFileDragDrop((event) => {
      if (event.type === 'leave') {
        setDropState(null);
        return;
      }
      const inside = pointInside(surfaceRef.current, event.position);
      if (event.type === 'drop') {
        setDropState(null);
        if (!inside) return;
        if (event.rejected > 0) {
          runtime.notifications.error(t('terminal.filePasteRejected', { count: event.rejected }));
        }
        requestSources(event.files.map((file) => ({ kind: 'native-path', file })));
        return;
      }
      if (!inside) {
        setDropState(null);
        return;
      }
      const mode = runtime.terminalFileLinks?.isLocalInstance?.() === true ? 'local' : 'upload';
      setDropState({ count: Math.max(1, event.paths.length), mode });
    });
  }, [enabled, requestSources, runtime, surfaceRef, t]);

  const handleDragEnter = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!enabled || runtime.host.onFileDragDrop || !hasExternalFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current += 1;
      setDropState({ count: Math.max(1, event.dataTransfer.items.length), mode: 'upload' });
    },
    [enabled, runtime]
  );

  const handleDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!enabled || runtime.host.onFileDragDrop || !hasExternalFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
    },
    [enabled, runtime]
  );

  const handleDragLeave = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!enabled || runtime.host.onFileDragDrop || !hasExternalFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current -= 1;
      if (dragDepthRef.current <= 0) {
        dragDepthRef.current = 0;
        setDropState(null);
      }
    },
    [enabled, runtime]
  );

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!enabled || runtime.host.onFileDragDrop || !hasExternalFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      setDropState(null);
      const files = Array.from(event.dataTransfer.files);
      requestSources(files.map((file) => ({ kind: 'file', file })));
    },
    [enabled, requestSources, runtime]
  );

  return {
    cancelRisk,
    confirmRisk,
    dropState,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handlePasteCapture,
    pasteFromClipboard,
    riskPrompt,
  };
}

export function TerminalFileDropOverlay({
  state,
  t,
}: {
  state: TerminalFileDropState | null;
  t: Translate;
}) {
  if (!state) return null;
  return (
    <HostLayerElement
      kind="drag-feedback"
      input="passthrough"
      backdrop="blur"
      z={40}
      className="pointer-events-none absolute inset-2 z-40 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-primary/70 bg-background/90 px-6 text-center shadow-2xl backdrop-blur-sm"
      data-testid="terminal-file-drop-overlay"
      role="status"
      aria-live="polite"
    >
      <span className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
        <FileUp className="size-6" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">
          {t(
            state.mode === 'local' ? 'terminal.fileDropLocalTitle' : 'terminal.fileDropUploadTitle'
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('terminal.fileDropHint', { count: state.count })}
        </p>
      </div>
    </HostLayerElement>
  );
}

export function TerminalFileRiskDialog({
  prompt,
  t,
  onCancel,
  onConfirm,
}: {
  prompt: TerminalFileRiskPrompt | null;
  t: Translate;
  onCancel(): void;
  onConfirm(): void;
}) {
  const names = prompt?.names ?? [];
  return (
    <AlertDialog open={prompt !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent data-testid="terminal-file-risk-dialog">
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <ShieldAlert className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t('terminal.fileRiskTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('terminal.fileRiskDescription')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs text-foreground">
          {names.slice(0, 4).map((name, index) => (
            <div key={`${name}\u0000${index}`} className="truncate py-0.5" title={name}>
              {name}
            </div>
          ))}
          {names.length > 4 && (
            <div className="pt-1 text-muted-foreground">
              {t('terminal.fileRiskMore', { count: names.length - 4 })}
            </div>
          )}
          {prompt && prompt.totalCount > names.length && (
            <div className="pt-1 text-muted-foreground">
              {t('terminal.fileRiskBatch', { count: prompt.totalCount })}
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} data-testid="terminal-file-risk-confirm">
            {t('terminal.fileRiskConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
