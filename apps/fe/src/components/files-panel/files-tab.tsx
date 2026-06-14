import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Device, FileEntryDto, FileErrorCode, FileRootDto } from '@tmex/shared';
import {
  ChevronRight,
  Download,
  Globe,
  Loader2,
  Monitor,
  RotateCw,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarGroup, useSidebar } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { fileNodeKey, useFileTreeStore } from '@/stores/file-tree';
import { decodeFileRef, fileRawUrl, fileRoute } from '@/utils/fileUrl';
import { type FileApiError, fetchFileList, fetchFileRoots } from './api';
import { fileIconColor, fileIconFor } from './file-icon';
import { buildRsyncInstallPrompt, triggerRsyncInstall } from './rsync-install-flow';

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
        <div className="space-y-0.5 pr-1 pb-2 select-none [-webkit-touch-callout:none] [-webkit-user-select:none]">
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
      <button
        type="button"
        onClick={() => toggle(rootId, path)}
        data-testid={`file-dir-${rootId}-${path}`}
        style={{ paddingLeft: indent }}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors hover:bg-accent/40 [@media(any-pointer:coarse)]:py-1.5',
          isRoot ? 'font-medium text-foreground' : 'text-foreground'
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
              <FileLeaf key={entry.path} entry={entry} rootId={rootId} depth={depth + 1} />
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
  rootId,
  depth,
}: { entry: FileEntryDto; rootId: string; depth: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const selected = useSelectedFilePath();
  const isSelected = selected?.rootId === rootId && selected?.path === entry.path;
  const Icon = fileIconFor(entry);
  const indent = depth * INDENT_STEP + 4 + 18;

  const open = () => {
    navigate(fileRoute(rootId, entry.path));
    if (isMobile) setOpenMobile(false);
  };

  return (
    <div className="group/file relative flex items-center">
      <button
        type="button"
        onClick={open}
        data-testid={`file-item-${rootId}-${entry.path}`}
        title={entry.name}
        style={{ paddingLeft: indent }}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-9 text-left transition-colors [@media(any-pointer:coarse)]:py-1.5',
          isSelected ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent/30'
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
      <a
        href={fileRawUrl(rootId, entry.path, true)}
        download={entry.name}
        onClick={(e) => e.stopPropagation()}
        data-testid={`file-download-${rootId}-${entry.path}`}
        title={t('files.download')}
        className={cn(
          'absolute top-1/2 right-1 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-background hover:text-foreground',
          'opacity-0 group-hover/file:opacity-100 [@media(any-pointer:coarse)]:opacity-100'
        )}
      >
        <Download className="h-3 w-3" />
      </a>
    </div>
  );
}
