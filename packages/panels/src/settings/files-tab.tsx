import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateFileRootRequest,
  Device,
  DeviceType,
  FileRootDto,
  UpdateFileRootRequest,
} from '@tmex/shared';
import { Globe, Loader2, Monitor, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@tmex/ui/toast';

import {
  type ApiClient,
  FileApiError,
  createFileRoot,
  deleteFileRoot,
  fetchFileRoots,
  updateFileRoot,
} from '@tmex/api-client';
import { useRuntime } from '@tmex/stores/react';
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
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Input } from '@tmex/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@tmex/ui/select';
import { Switch } from '@tmex/ui/switch';

interface DevicesResponse {
  devices: Device[];
}

/** 增改弹窗设备选择器里的一个可选设备。 */
export interface FileRootDeviceOption {
  id: string;
  name: string;
  type?: DeviceType;
}

/** 注入的设备分组：组标签 + 组内设备 + 该组 file roots 的落盘 client。 */
export interface FileRootDeviceGroup {
  label: string;
  devices: FileRootDeviceOption[];
  /** 缺省用当前 runtime 的 apiClient */
  apiClient?: ApiClient;
}

export interface FilesSettingsTabProps {
  /**
   * 注入设备清单数据源（分组显示）。同时决定 file roots 的读写路径：列表聚合各组
   * client 的 roots，创建/更新/删除路由到对应组的 client。缺省（不传）取本 gateway
   * 的 /api/devices 且读写本 gateway。
   */
  deviceGroups?: FileRootDeviceGroup[];
  /**
   * roots 增删改成功后的通知。组件内部只失效自身 QueryClient 的 ['files'] 缓存，
   * 宿主若在其他缓存域（另一个 QueryClient）也展示 roots，可借此扇出失效。
   */
  onRootsMutated?: () => void;
}

/** 聚合列表里的一条 root 及其来源 client（更新/删除沿用来源）。 */
interface FileRootEntry {
  root: FileRootDto;
  client: ApiClient;
}

function DeviceIcon({ type, className }: { type: 'local' | 'ssh' | null; className?: string }) {
  if (type === 'ssh') {
    return <Globe className={className} />;
  }
  return <Monitor className={className} />;
}

// 外壳门：runtime.features.filesUi 关断时不渲染文件根设置卡，也不发起 files 查询（内层 hooks 不执行）。
export function FilesSettingsTab(props: FilesSettingsTabProps = {}) {
  const { features } = useRuntime();
  if (!features.filesUi) return null;
  return <FilesSettingsTabInner {...props} />;
}

function FilesSettingsTabInner({ deviceGroups, onRootsMutated }: FilesSettingsTabProps) {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<FileRootEntry | undefined>(undefined);

  const rootsQuery = useQuery({
    queryKey: ['files', 'roots'],
    queryFn: async (): Promise<FileRootEntry[]> => {
      if (!deviceGroups) {
        const res = await fetchFileRoots(apiClient);
        return res.roots.map((root) => ({ root, client: apiClient }));
      }
      const clients: ApiClient[] = [];
      for (const group of deviceGroups) {
        const client = group.apiClient ?? apiClient;
        if (!clients.includes(client)) {
          clients.push(client);
        }
      }
      const results = await Promise.all(clients.map((client) => fetchFileRoots(client)));
      return results.flatMap((res, index) =>
        res.roots.map((root) => ({ root, client: clients[index] }))
      );
    },
  });

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await apiClient.fetch('/api/devices');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return (await res.json()) as DevicesResponse;
    },
    throwOnError: false,
    enabled: !deviceGroups,
  });

  const entries = rootsQuery.data ?? [];
  const devices = devicesQuery.data?.devices ?? [];

  const openAdd = () => {
    setEditingEntry(undefined);
    setModalOpen(true);
  };

  const openEdit = (entry: FileRootEntry) => {
    setEditingEntry(entry);
    setModalOpen(true);
  };

  return (
    <>
      <Card className="border-0 ring-0" data-testid="settings-files-section">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle>{t('settings.files.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('settings.files.description')}</p>
          </div>
          <Button variant="secondary" data-testid="settings-files-root-add" onClick={openAdd}>
            <Plus className="h-4 w-4" />
            {t('settings.files.addRoot')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {rootsQuery.isLoading && (
            <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
          )}

          {!rootsQuery.isLoading && entries.length === 0 && (
            <div className="text-sm text-muted-foreground" data-testid="settings-files-empty">
              {t('settings.files.empty')}
            </div>
          )}

          {entries.map((entry) => (
            <FileRootRow
              key={entry.root.id}
              root={entry.root}
              client={entry.client}
              onEdit={() => openEdit(entry)}
              onRootsMutated={onRootsMutated}
            />
          ))}
        </CardContent>
      </Card>

      <FileRootFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        root={editingEntry?.root}
        editClient={editingEntry?.client}
        devices={devices}
        deviceGroups={deviceGroups}
        onRootsMutated={onRootsMutated}
      />
    </>
  );
}

interface FileRootRowProps {
  root: FileRootDto;
  /** 该 root 的来源 client：更新/删除沿用 */
  client: ApiClient;
  onEdit: () => void;
  onRootsMutated?: () => void;
}

function FileRootRow({ root, client, onEdit, onRootsMutated }: FileRootRowProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateFileRoot(id, { enabled } satisfies UpdateFileRootRequest, client),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['files'] });
      onRootsMutated?.();
    },
    onError: () => {
      toast.error(t('settings.files.toggleFailed'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteFileRoot(id, client),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['files'] });
      onRootsMutated?.();
      toast.success(t('common.success'));
    },
    onError: (err) => {
      const message = err instanceof FileApiError ? err.message : t('settings.files.deleteFailed');
      toast.error(message);
    },
  });

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border p-3"
      data-testid={`settings-files-root-${root.id}`}
    >
      <Switch
        checked={root.enabled}
        disabled={toggleMutation.isPending}
        onCheckedChange={(checked) =>
          toggleMutation.mutate({ id: root.id, enabled: Boolean(checked) })
        }
        data-testid={`settings-files-root-enabled-${root.id}`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <DeviceIcon type={root.deviceType} className="h-3.5 w-3.5 shrink-0" />
          {root.deviceName === null ? (
            <span className="text-destructive">{t('settings.files.missing')}</span>
          ) : (
            <span className="truncate">{root.deviceName}</span>
          )}
        </div>
        <div className="truncate font-mono text-xs">{root.path}</div>
        <div className="truncate text-xs text-muted-foreground">{root.name}</div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('common.edit')}
          data-testid={`settings-files-root-edit-${root.id}`}
          onClick={onEdit}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('common.delete')}
          data-testid={`settings-files-root-delete-${root.id}`}
          onClick={() => setShowDeleteConfirm(true)}
          disabled={deleteMutation.isPending}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <Trash2 className="h-5 w-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('settings.files.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.files.deleteDesc', { path: root.path })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid={`settings-files-root-delete-confirm-${root.id}`}
              onClick={() => {
                deleteMutation.mutate(root.id);
                setShowDeleteConfirm(false);
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const FIELD_CLASS = 'h-9 w-full';

interface FileRootFormModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 缺省表示新增模式 */
  root?: FileRootDto;
  /** 编辑模式下该 root 的来源 client；缺省用 runtime 的 apiClient */
  editClient?: ApiClient;
  devices: Device[];
  deviceGroups?: FileRootDeviceGroup[];
  onRootsMutated?: () => void;
}

function FileRootFormModal({
  open,
  onOpenChange,
  root,
  editClient,
  devices,
  deviceGroups,
  onRootsMutated,
}: FileRootFormModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { apiClient } = useRuntime();
  const isEdit = Boolean(root);

  const allDeviceOptions: FileRootDeviceOption[] = deviceGroups
    ? deviceGroups.flatMap((group) => group.devices)
    : devices;

  const resolveCreateClient = (targetDeviceId: string): ApiClient => {
    if (!deviceGroups) {
      return apiClient;
    }
    const group = deviceGroups.find((g) => g.devices.some((d) => d.id === targetDeviceId));
    return group?.apiClient ?? apiClient;
  };

  const [deviceId, setDeviceId] = useState('');
  const [path, setPath] = useState('');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDeviceId(root?.deviceId ?? '');
    setPath(root?.path ?? '');
    setEnabled(root?.enabled ?? true);
  }, [open, root]);

  const createMutation = useMutation({
    mutationFn: () => {
      const payload: CreateFileRootRequest = { deviceId, path: path.trim(), enabled };
      return createFileRoot(payload, resolveCreateClient(deviceId));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['files'] });
      onRootsMutated?.();
      toast.success(t('common.success'));
      onOpenChange(false);
    },
    onError: (err) => {
      const message = err instanceof FileApiError ? err.message : t('settings.files.addFailed');
      toast.error(message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!root) {
        throw new Error(t('settings.files.updateFailed'));
      }
      const payload: UpdateFileRootRequest = { path: path.trim(), enabled };
      return updateFileRoot(root.id, payload, editClient ?? apiClient);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['files'] });
      onRootsMutated?.();
      toast.success(t('common.success'));
      onOpenChange(false);
    },
    onError: (err) => {
      const message = err instanceof FileApiError ? err.message : t('settings.files.updateFailed');
      toast.error(message);
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;
  const trimmedPath = path.trim();
  const pathValid = trimmedPath.startsWith('/');
  const canSubmit = pathValid && (isEdit || deviceId.length > 0);

  const handleSubmit = () => {
    if (!canSubmit || isPending) {
      return;
    }
    if (isEdit) {
      updateMutation.mutate();
    } else {
      createMutation.mutate();
    }
  };

  const selectedDevice = allDeviceOptions.find((device) => device.id === deviceId);

  const renderDeviceItem = (device: FileRootDeviceOption) => (
    <SelectItem key={device.id} value={device.id}>
      <DeviceIcon type={device.type ?? null} className="h-4 w-4 shrink-0" />
      {device.name}
    </SelectItem>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid={isEdit ? `settings-files-edit-modal-${root?.id}` : 'settings-files-add-modal'}
      >
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('settings.files.modalEditTitle') : t('settings.files.modalAddTitle')}
          </DialogTitle>
          <DialogDescription>{t('settings.files.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="files-form-device">
              {t('settings.files.device')}
            </label>
            {isEdit ? (
              <div className="flex h-9 items-center gap-1.5 rounded-lg border border-input bg-muted/30 px-2.5 text-sm">
                <DeviceIcon type={root?.deviceType ?? null} className="h-4 w-4 shrink-0" />
                <span className="truncate">{root?.deviceName ?? t('settings.files.missing')}</span>
              </div>
            ) : (
              <Select
                value={deviceId}
                onValueChange={(value) => {
                  if (!value) return;
                  setDeviceId(value);
                }}
              >
                <SelectTrigger
                  id="files-form-device"
                  data-testid="settings-files-device-select"
                  className={FIELD_CLASS}
                  disabled={allDeviceOptions.length === 0}
                >
                  <SelectValue>
                    {selectedDevice ? (
                      <span className="flex items-center gap-1.5">
                        <DeviceIcon
                          type={selectedDevice.type ?? null}
                          className="h-4 w-4 shrink-0"
                        />
                        {selectedDevice.name}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {t('settings.files.devicePlaceholder')}
                      </span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {deviceGroups
                    ? deviceGroups.map((group, index) => (
                        <SelectGroup key={`${group.label}-${index}`}>
                          {group.label ? <SelectLabel>{group.label}</SelectLabel> : null}
                          {group.devices.map(renderDeviceItem)}
                        </SelectGroup>
                      ))
                    : devices.map(renderDeviceItem)}
                </SelectContent>
              </Select>
            )}
            {!isEdit && allDeviceOptions.length === 0 && (
              <p className="text-xs text-destructive">{t('settings.files.noDevices')}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="files-form-path">
              {t('settings.files.path')}
            </label>
            <Input
              id="files-form-path"
              data-testid="settings-files-path-input"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={t('settings.files.pathPlaceholder')}
              className={`${FIELD_CLASS} font-mono`}
            />
            <p className="text-xs text-muted-foreground">{t('settings.files.pathHint')}</p>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(Boolean(checked))}
              data-testid="settings-files-enabled-switch"
            />
            <label className="text-sm font-medium" htmlFor="settings-files-enabled-switch">
              {t('settings.files.enabled')}
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            data-testid="settings-files-form-submit"
            onClick={handleSubmit}
            disabled={!canSubmit || isPending}
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
