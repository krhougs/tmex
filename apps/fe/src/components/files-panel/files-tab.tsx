import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Device, FileEntryDto, FileErrorCode, FileRootDto, SystemInfo } from '@tmex/shared';
import { writeTextToClipboard } from 'ghostty-terminal';
import {
  Bot,
  ChevronRight,
  ChevronsUpDown,
  Copy,
  Download,
  FolderOpen,
  Globe,
  Link,
  Loader2,
  Monitor,
  RotateCw,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarGroup, useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { fileNodeKey, useFileTreeStore } from '@/stores/file-tree';
import { decodeFileRef, fileDownloadUrl, fileRoute } from '@/utils/fileUrl';
import {
  type FileApiError,
  downloadFileWithProgress,
  fetchFileList,
  fetchFileRoots,
  uploadFileChunked,
} from './api';
import { fileIconColor, fileIconFor } from './file-icon';
import { formatBytes } from './format';
import {
  buildRsyncInstallPrompt,
  sendPathToAgent,
  triggerRsyncInstall,
} from './rsync-install-flow';
import { startTransferToast } from './transfer-toast';

const DEFAULT_TRANSFER_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const INDENT_STEP = 12;
const LIST_STALE_MS = 2000; // 收起+展开重试的防抖窗口
const LIST_POLL_MS = 30_000; // 仅对健康的已展开目录轮询

interface ProvidersResponse {
  providers: Array<{ id: string; enabled: boolean }>;
}
interface DevicesResponse {
  devices: Device[];
}

function parentOf(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '/';
  return p.slice(0, idx);
}

// 相对于树根的路径：剥离 root 前缀；root 自身返回 '.'。
function relativeToRoot(rootPath: string, path: string): string {
  if (path === rootPath) return '.';
  const prefix = rootPath === '/' ? '/' : `${rootPath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

async function copyText(text: string, okMsg: string, failMsg: string): Promise<void> {
  try {
    await writeTextToClipboard(text);
    toast.success(okMsg);
  } catch {
    toast.error(failMsg);
  }
}

// 外部 OS 文件拖入判定：Firefox 的 dataTransfer.types 是 DOMStringList（无 includes），故 Array.from。
function hasExternalFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

// 所有 node 共有的菜单项：复制绝对/相对位置、发送到 Agent。
function CommonNodeMenuItems({
  deviceId,
  absPath,
  rootPath,
}: {
  deviceId: string;
  absPath: string;
  rootPath: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <ContextMenuItem
        onClick={() => void copyText(absPath, t('files.copied'), t('files.copyFailed'))}
      >
        <Copy />
        {t('files.menu.copyAbsolute')}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() =>
          void copyText(relativeToRoot(rootPath, absPath), t('files.copied'), t('files.copyFailed'))
        }
      >
        <Link />
        {t('files.menu.copyRelative')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void sendPathToAgent(deviceId, absPath)}>
        <Bot />
        {t('files.menu.sendToAgent')}
      </ContextMenuItem>
    </>
  );
}

// 菜单头部：标明所属设备与完整绝对路径（长路径换行），避免误操作。
function NodeMenuHeader({ root, absPath }: { root: FileRootDto; absPath: string }) {
  const DeviceIcon = root.deviceType === 'ssh' ? Globe : Monitor;
  return (
    <div className="px-1.5 pt-1 pb-1.5">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <DeviceIcon className="h-3 w-3 shrink-0" />
        <span className="truncate">{root.deviceName ?? root.deviceId}</span>
      </div>
      <div className="mt-0.5 font-mono text-[11px] break-all text-foreground/70">{absPath}</div>
    </div>
  );
}

function useSelectedFilePath(): { rootId: string; path: string } | null {
  const location = useLocation();
  return useMemo(() => {
    const match = matchPath('/file/:ref', location.pathname);
    if (!match?.params.ref) return null;
    return decodeFileRef(match.params.ref);
  }, [location.pathname]);
}

function errorKey(code?: FileErrorCode): string {
  return `files.error.${code ?? 'unknown'}`;
}

interface TreeContext {
  llmConfigured: boolean;
  localDeviceId: string | null;
  transferMaxBytes: number;
}

export function FilesTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isFetching = useIsFetching({ queryKey: ['files'] });
  const pruneStaleRoots = useFileTreeStore((s) => s.pruneStaleRoots);

  const rootsQuery = useQuery({
    queryKey: ['files', 'roots'],
    queryFn: fetchFileRoots,
    refetchOnWindowFocus: true,
  });
  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error('devices');
      return (await res.json()) as DevicesResponse;
    },
  });
  const providersQuery = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const res = await fetch('/api/llm/providers');
      if (!res.ok) throw new Error('providers');
      return (await res.json()) as ProvidersResponse;
    },
    throwOnError: false,
  });
  const systemInfoQuery = useQuery({
    queryKey: ['system', 'info'],
    queryFn: async () => {
      const res = await fetch('/api/system/info');
      if (!res.ok) throw new Error('system');
      return (await res.json()) as SystemInfo;
    },
    throwOnError: false,
  });

  const roots = useMemo(
    () => (rootsQuery.data?.roots ?? []).filter((r) => r.enabled),
    [rootsQuery.data]
  );

  // 加载后清理陈旧的持久化展开键（根/设备已不存在）
  useEffect(() => {
    if (rootsQuery.data) pruneStaleRoots(rootsQuery.data.roots.map((r) => r.id));
  }, [rootsQuery.data, pruneStaleRoots]);

  const ctx: TreeContext = {
    llmConfigured: (providersQuery.data?.providers ?? []).length > 0,
    localDeviceId: devicesQuery.data?.devices.find((d) => d.type === 'local')?.id ?? null,
    transferMaxBytes: systemInfoQuery.data?.transferMaxBytes ?? DEFAULT_TRANSFER_MAX_BYTES,
  };

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['files'] });

  return (
    <SidebarGroup className="flex min-h-0 flex-1 flex-col pt-0" data-testid="files-tab">
      <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
        <span className="truncate text-xs font-medium text-muted-foreground">
          {t('files.title')}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={refresh}
          title={t('files.refresh')}
          data-testid="files-refresh"
        >
          <RotateCw className={cn('h-3.5 w-3.5', isFetching > 0 && 'animate-spin')} />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div
          // 兜底：阻止把文件拖到非文件夹区域时浏览器默认打开/导航；真正的上传由 DirNode 的 onDrop 处理
          onDragOver={(e) => {
            if (hasExternalFiles(e)) e.preventDefault();
          }}
          onDrop={(e) => {
            if (hasExternalFiles(e)) e.preventDefault();
          }}
          className="space-y-0.5 pr-1 pb-2 select-none [-webkit-touch-callout:none] [-webkit-user-select:none]"
        >
          {roots.map((root) => (
            <DirNode
              key={root.id}
              root={root}
              rootId={root.id}
              path={root.path}
              depth={0}
              isRoot
              ctx={ctx}
            />
          ))}
          {rootsQuery.isLoading && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t('common.loading')}
            </div>
          )}
          {!rootsQuery.isLoading && roots.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t('files.noRoots')}
            </div>
          )}
        </div>
      </ScrollArea>
    </SidebarGroup>
  );
}

function DeviceBadge({ root }: { root: FileRootDto }) {
  const Icon = root.deviceType === 'ssh' ? Globe : Monitor;
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/70">
      <Icon className="h-3 w-3" />
      <span className="max-w-24 truncate">{root.deviceName ?? '—'}</span>
    </span>
  );
}

function DirNode({
  root,
  rootId,
  path,
  depth,
  isRoot,
  ctx,
}: {
  root: FileRootDto;
  rootId: string;
  path: string;
  depth: number;
  isRoot: boolean;
  ctx: TreeContext;
}) {
  const { t } = useTranslation();
  const nodeKey = fileNodeKey(rootId, path);
  const expanded = useFileTreeStore((s) => Boolean(s.expanded[nodeKey]));
  const toggle = useFileTreeStore((s) => s.toggle);
  const expand = useFileTreeStore((s) => s.expand);
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  const resetDrag = () => {
    dragDepth.current = 0;
    setDragActive(false);
  };

  // 上传到本目录：逐文件分块上传 + 进度 Toast（可取消）；完成后展开并刷新该目录列表。
  const doUpload = async (files: File[]) => {
    if (files.length === 0) return;
    for (const file of files) {
      if (file.size > ctx.transferMaxBytes) {
        toast.error(
          t('files.transfer.tooLarge', { name: file.name, max: formatBytes(ctx.transferMaxBytes) })
        );
        continue;
      }
      const controller = new AbortController();
      const tt = startTransferToast(file.name, 'upload', () => controller.abort());
      try {
        await uploadFileChunked(rootId, path, file, {
          onLeg: tt.leg,
          signal: controller.signal,
        });
        tt.success(t('files.upload.success', { name: file.name }));
      } catch {
        if (controller.signal.aborted) tt.fail(t('files.transfer.canceled', { name: file.name }));
        else tt.fail(t('files.upload.fail', { name: file.name }));
      }
    }
    expand(rootId, path);
    void queryClient.invalidateQueries({ queryKey: ['files', 'list', rootId, path] });
  };

  const query = useQuery({
    queryKey: ['files', 'list', rootId, path],
    queryFn: () => fetchFileList(rootId, path),
    enabled: expanded,
    staleTime: LIST_STALE_MS,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.status === 'error' ? false : LIST_POLL_MS),
    refetchIntervalInBackground: false,
  });

  const errCode = (query.error as FileApiError | undefined)?.code;

  // rsync 缺失：弹出带「自动安装」按钮的 toast（仅当配置过 LLM），一次/恢复后重置
  const toastFiredRef = useRef<string | null>(null);
  useEffect(() => {
    const isRsyncMissing = errCode === 'rsync_missing_local' || errCode === 'rsync_missing_remote';
    if (!isRsyncMissing) {
      toastFiredRef.current = null;
      return;
    }
    if (toastFiredRef.current === nodeKey) return;
    toastFiredRef.current = nodeKey;

    const remote = errCode === 'rsync_missing_remote';
    const installDeviceId = remote
      ? root.deviceId
      : root.deviceType === 'local'
        ? root.deviceId
        : ctx.localDeviceId;

    const toastId = `rsync-missing-${nodeKey}`;
    toast.error(t(errorKey(errCode)), {
      id: toastId,
      description: root.deviceName ? `${root.deviceName}` : undefined,
      action:
        ctx.llmConfigured && installDeviceId
          ? {
              label: t('files.install.button'),
              onClick: () => {
                // 一次性：立即清除当前 toast，再触发安装编排
                toast.dismiss(toastId);
                void triggerRsyncInstall(
                  installDeviceId,
                  buildRsyncInstallPrompt(root.deviceName ?? root.deviceId, remote)
                );
              },
            }
          : undefined,
    });
  }, [errCode, nodeKey, root, ctx.llmConfigured, ctx.localDeviceId, t]);

  // reconcile：成功刷新后，把「曾展开但已消失」的直接子目录折叠掉（同一 root 下）
  useEffect(() => {
    if (!query.data) return;
    const childDirs = new Set(
      query.data.entries.filter((e) => e.type === 'dir').map((e) => e.path)
    );
    const store = useFileTreeStore.getState();
    const prefix = `${rootId}\n`;
    for (const key of Object.keys(store.expanded)) {
      if (!key.startsWith(prefix)) continue;
      const p = key.slice(prefix.length);
      // 只剪「直接子目录」：必须排除本节点自身（path === '/' 时 parentOf('/') === '/' 会误判自身为子，
      // 导致根 '/' 加载后自己折叠 → 闪一下就收起）。
      if (p !== path && parentOf(p) === path && !childDirs.has(p)) store.collapse(rootId, p);
    }
  }, [query.data, rootId, path]);

  const Icon = fileIconFor({ category: 'directory', name: root.name, type: 'dir' }, { expanded });
  const indent = depth * INDENT_STEP + 4;
  const childIndent = indent + 18;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <button
              type="button"
              onClick={() => toggle(rootId, path)}
              onDragEnter={(e) => {
                if (!hasExternalFiles(e)) return;
                e.preventDefault();
                dragDepth.current += 1;
                setDragActive(true);
              }}
              onDragOver={(e) => {
                if (!hasExternalFiles(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }}
              onDragLeave={(e) => {
                if (!hasExternalFiles(e)) return;
                dragDepth.current -= 1;
                if (dragDepth.current <= 0) resetDrag();
              }}
              onDrop={(e) => {
                if (!hasExternalFiles(e)) return;
                e.preventDefault();
                resetDrag();
                void doUpload(Array.from(e.dataTransfer.files));
              }}
              data-testid={`file-dir-${rootId}-${path}`}
              style={{ paddingLeft: indent }}
              className={cn(
                'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent data-[pressed]:bg-sidebar-accent [@media(any-pointer:coarse)]:py-1.5',
                isRoot ? 'font-medium text-foreground' : 'text-foreground',
                dragActive && 'bg-primary/15 ring-1 ring-primary/40 ring-inset'
              )}
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                  expanded && 'rotate-90'
                )}
              />
              <Icon
                className={cn(
                  'h-4 w-4 shrink-0',
                  isRoot ? 'text-muted-foreground' : fileIconColor('directory')
                )}
              />
              <span className="min-w-0 flex-1 truncate text-xs">
                {isRoot ? root.name : nodeBasename(path)}
              </span>
              {isRoot && <DeviceBadge root={root} />}
            </button>
          }
        />
        <ContextMenuContent>
          <NodeMenuHeader root={root} absPath={path} />
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => toggle(rootId, path)}>
            <ChevronsUpDown />
            {expanded ? t('files.menu.collapse') : t('files.menu.expand')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => fileInputRef.current?.click()}>
            <Upload />
            {t('files.menu.upload')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <CommonNodeMenuItems deviceId={root.deviceId} absPath={path} rootPath={root.path} />
        </ContextMenuContent>
      </ContextMenu>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void doUpload(files);
        }}
      />

      {expanded && (
        <div>
          {(query.isLoading || (query.isFetching && !query.data)) && (
            <div
              style={{ paddingLeft: childIndent }}
              className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground"
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              {t('common.loading')}
            </div>
          )}
          {query.isError && (
            <NodeError code={errCode} indent={childIndent} onRetry={() => void query.refetch()} />
          )}
          {query.data?.entries.map((entry) =>
            entry.type === 'dir' ? (
              <DirNode
                key={entry.path}
                root={root}
                rootId={rootId}
                path={entry.path}
                depth={depth + 1}
                isRoot={false}
                ctx={ctx}
              />
            ) : (
              <FileLeaf key={entry.path} entry={entry} root={root} depth={depth + 1} />
            )
          )}
          {query.data && query.data.entries.length === 0 && (
            <div
              style={{ paddingLeft: childIndent }}
              className="py-1 text-[11px] text-muted-foreground/70"
            >
              {t('files.emptyDir')}
            </div>
          )}
          {query.data?.truncated && (
            <div
              style={{ paddingLeft: childIndent }}
              className="py-1 text-[11px] text-muted-foreground/70"
            >
              {t('files.truncated')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NodeError({
  code,
  indent,
  onRetry,
}: {
  code?: FileErrorCode;
  indent: number;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{ paddingLeft: indent }}
      className="flex items-start gap-1.5 py-1 pr-2 text-[11px] text-destructive/80"
    >
      <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1">{t(`files.error.${code ?? 'unknown'}`)}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title={t('files.retry')}
      >
        <RotateCw className="h-3 w-3" />
      </button>
    </div>
  );
}

function nodeBasename(p: string): string {
  const i = p.lastIndexOf('/');
  const b = i >= 0 ? p.slice(i + 1) : p;
  return b || p;
}

function FileLeaf({
  entry,
  root,
  depth,
}: { entry: FileEntryDto; root: FileRootDto; depth: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const selected = useSelectedFilePath();
  const rootId = root.id;
  const isSelected = selected?.rootId === rootId && selected?.path === entry.path;
  const Icon = fileIconFor(entry);
  const indent = depth * INDENT_STEP + 4 + 18;

  const open = () => {
    navigate(fileRoute(rootId, entry.path));
    if (isMobile) setOpenMobile(false);
  };

  // 应用内下载：流式拉取 + 进度 Toast（可取消）→ Blob 触发保存。
  const doDownload = async () => {
    const controller = new AbortController();
    const tt = startTransferToast(entry.name, 'download', () => controller.abort());
    try {
      await downloadFileWithProgress(rootId, entry.path, entry.name, {
        onLeg: tt.leg,
        signal: controller.signal,
      });
      tt.success(t('files.transfer.downloaded', { name: entry.name }));
    } catch {
      if (controller.signal.aborted) tt.fail(t('files.transfer.canceled', { name: entry.name }));
      else tt.fail(t('files.transfer.downloadFailed', { name: entry.name }));
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <button
            type="button"
            draggable
            onClick={open}
            onDragStart={(e) => {
              // 拖到系统下载（仅 Chromium 生效，URL 必须绝对；其它浏览器静默无效，菜单「下载」兜底）
              const absUrl = window.location.origin + fileDownloadUrl(rootId, entry.path);
              e.dataTransfer.setData(
                'DownloadURL',
                `application/octet-stream:${entry.name}:${absUrl}`
              );
              e.dataTransfer.effectAllowed = 'copy';
            }}
            data-testid={`file-item-${rootId}-${entry.path}`}
            title={entry.name}
            style={{ paddingLeft: indent }}
            className={cn(
              'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors data-[pressed]:bg-sidebar-accent [@media(any-pointer:coarse)]:py-1.5',
              isSelected
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-foreground'
            )}
          >
            <Icon
              className={cn(
                'h-4 w-4 shrink-0',
                isSelected ? 'text-primary' : fileIconColor(entry.category)
              )}
            />
            <span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>
            {entry.isSymlink && (
              <span className="shrink-0 text-[9px] text-muted-foreground/60" title="symlink">
                ↗
              </span>
            )}
          </button>
        }
      />
      <ContextMenuContent>
        <NodeMenuHeader root={root} absPath={entry.path} />
        <ContextMenuSeparator />
        <ContextMenuItem onClick={open}>
          <FolderOpen />
          {t('files.menu.open')}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => void doDownload()}
          data-testid={`file-download-${rootId}-${entry.path}`}
        >
          <Download />
          {t('files.download')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <CommonNodeMenuItems deviceId={root.deviceId} absPath={entry.path} rootPath={root.path} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
