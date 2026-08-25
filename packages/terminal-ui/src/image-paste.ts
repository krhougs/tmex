import { formatBytes, uploadFileChunked } from '@tmex/api-client';
import { PASTE_IMAGE_MAX_BYTES } from '@tmex/shared';
import type { RuntimeCore } from '@tmex/stores';
import { startTransferToast } from './components/transfer-toast';

export type TerminalImagePasteTarget = {
  rootId: string;
  directory: string;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function resolveTerminalImagePasteTarget(
  currentPath: string | null | undefined,
  roots: readonly { id: string; path: string }[]
): TerminalImagePasteTarget | null {
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

export function reportTerminalImageTooLarge(
  runtime: RuntimeCore,
  t: Translate,
  size: number
): void {
  runtime.notifications.error(
    t('terminal.imagePasteTooLarge', {
      size: formatBytes(size),
      limit: formatBytes(PASTE_IMAGE_MAX_BYTES),
    })
  );
}
export async function uploadTerminalImage(args: {
  source: File;
  target: TerminalImagePasteTarget | null;
  runtime: RuntimeCore;
  t: Translate;
  controllers?: Set<AbortController>;
  injectPath(path: string): boolean | Promise<boolean>;
}): Promise<void> {
  const { source, target, runtime, t, injectPath, controllers } = args;
  if (source.size > PASTE_IMAGE_MAX_BYTES) {
    reportTerminalImageTooLarge(runtime, t, source.size);
    return;
  }
  if (!target) {
    runtime.notifications.error(t('terminal.imagePasteNoRoot'));
    return;
  }

  const file = new File([source], `paste-${Date.now()}.${pasteImageExtension(source.type)}`, {
    type: source.type || 'image/png',
  });
  const controller = new AbortController();
  controllers?.add(controller);
  const transfer = startTransferToast(file.name, 'upload', () => controller.abort());
  try {
    const uploaded = await uploadFileChunked(
      target.rootId,
      target.directory,
      file,
      {
        kind: 'paste-image',
        signal: controller.signal,
        onLeg: transfer.leg,
      },
      runtime.apiClient
    );
    if (await injectPath(quoteTerminalPath(uploaded))) {
      transfer.success(t('terminal.imagePasteUploaded', { path: uploaded }));
    } else {
      await runtime.host.writeClipboardText(uploaded);
      transfer.success(t('terminal.imagePastePathCopied', { path: uploaded }));
    }
  } catch (error) {
    if (controller.signal.aborted) {
      transfer.cancel();
    } else {
      transfer.fail(
        t('terminal.imagePasteFailed', {
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }
  } finally {
    controllers?.delete(controller);
  }
}
