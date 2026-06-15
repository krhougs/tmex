import { DeviceStatusBadge } from '@/components/device-status-badge';
import { useSiteStore } from '@/stores/site';
import { useTmuxStore } from '@/stores/tmux';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDeviceRequest, Device, UpdateDeviceRequest } from '@tmex/shared';
import { toBCP47 } from '@tmex/shared';

type DeviceListItem = Device & {
  lastError?: string | null;
  lastErrorType?: string | null;
};
import { Globe, Monitor, MoreHorizontal, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { type FormEvent, useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';

type DeviceFormValues = {
  name: string;
  type: 'local' | 'ssh';
  host: string;
  port: number;
  username: string;
  sshConfigRef: string;
  session: string;
  authMode: CreateDeviceRequest['authMode'];
  password: string;
  privateKey: string;
  privateKeyPassphrase: string;
};

function normalizeText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function createDefaultFormValues(device?: Device): DeviceFormValues {
  if (!device) {
    return {
      name: '',
      type: 'local',
      host: '',
      port: 22,
      // SSH 字段预填预期默认值（与 placeholder 一致），减少新建 SSH 设备时的手填负担；
      // host 不预填（需用户填真实地址）；sshConfigRef 仅 configRef 模式用，默认留空。
      username: 'root',
      sshConfigRef: '',
      session: 'tmex',
      authMode: 'auto',
      password: '',
      privateKey: '',
      privateKeyPassphrase: '',
    };
  }

  return {
    name: device.name,
    type: device.type,
    host: device.host ?? '',
    port: device.port ?? 22,
    username: device.username ?? '',
    sshConfigRef: device.sshConfigRef ?? '',
    session: device.session ?? 'tmex',
    authMode: device.type === 'local' ? 'auto' : device.authMode,
    password: '',
    privateKey: '',
    privateKeyPassphrase: '',
  };
}

function buildCreatePayload(values: DeviceFormValues): CreateDeviceRequest {
  if (values.type === 'local') {
    return {
      name: values.name.trim(),
      type: 'local',
      session: normalizeText(values.session) ?? 'tmex',
      authMode: 'auto',
    };
  }

  // host/port/username 经 validateDeviceForm 强校验非空，显式发送具体值；
  // sshConfigRef 仅 configRef 模式才有意义
  const payload: CreateDeviceRequest = {
    name: values.name.trim(),
    type: 'ssh',
    host: values.host.trim(),
    port: values.port,
    username: values.username.trim(),
    session: normalizeText(values.session) ?? 'tmex',
    authMode: values.authMode,
  };

  if (values.authMode === 'configRef') {
    payload.sshConfigRef = values.sshConfigRef.trim();
  }

  if (values.authMode === 'password') {
    payload.password = values.password;
  }

  if (values.authMode === 'key') {
    payload.privateKey = values.privateKey;
    payload.privateKeyPassphrase = values.privateKeyPassphrase || undefined;
  }

  return payload;
}

function buildUpdatePayload(values: DeviceFormValues): UpdateDeviceRequest {
  if (values.type === 'local') {
    return {
      name: values.name.trim(),
      session: normalizeText(values.session) ?? 'tmex',
      authMode: 'auto',
    };
  }

  // 编辑时 host/port/username 同为强校验必填，显式发送具体值；
  // 非 configRef 模式显式清空 sshConfigRef，顺带清理历史脏数据（避免残留引用劫持 host）
  const payload: UpdateDeviceRequest = {
    name: values.name.trim(),
    host: values.host.trim(),
    port: values.port,
    username: values.username.trim(),
    sshConfigRef: values.authMode === 'configRef' ? values.sshConfigRef.trim() : '',
    session: normalizeText(values.session) ?? 'tmex',
    authMode: values.authMode,
  };

  if (values.authMode === 'password' && values.password) {
    payload.password = values.password;
  }

  if (values.authMode === 'key' && values.privateKey) {
    payload.privateKey = values.privateKey;
    payload.privateKeyPassphrase = values.privateKeyPassphrase || undefined;
  }

  return payload;
}

// 合法 SSH 端口：1–65535 的整数（清空输入会变成 NaN，视为非法）
function isValidSshPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// SSH 设备：host/端口/用户名在创建与编辑时均为强校验必填项；
// sshConfigRef 仅在认证方式为 configRef 时必填。
// 返回首个未通过校验的 i18n key，全部通过返回 null。
function validateDeviceForm(values: DeviceFormValues): string | null {
  if (values.type !== 'ssh') {
    return null;
  }
  if (!values.host.trim()) {
    return 'validation.hostRequired';
  }
  if (!isValidSshPort(values.port)) {
    return 'validation.portRequired';
  }
  if (!values.username.trim()) {
    return 'validation.usernameRequired';
  }
  if (values.authMode === 'configRef' && !values.sshConfigRef.trim()) {
    return 'validation.sshConfigRequired';
  }
  return null;
}

async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

export default function DevicesPage() {
  const { t } = useTranslation();
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<Device | null>(null);
  const queryClient = useQueryClient();
  const language = useSiteStore((state) => state.settings?.language ?? 'en_US');

  // Listen for open add device event from AppHeader
  useEffect(() => {
    const handleOpenAddDevice = () => setShowAddModal(true);
    window.addEventListener('tmex:open-add-device', handleOpenAddDevice);
    return () => window.removeEventListener('tmex:open-add-device', handleOpenAddDevice);
  }, []);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error(t('device.loadFailed'));
      return res.json() as Promise<{ devices: DeviceListItem[] }>;
    },
    throwOnError: false,
  });

  const hydrateDeviceErrors = useTmuxStore((state) => state.hydrateDeviceErrors);

  useEffect(() => {
    if (!data?.devices) return;
    hydrateDeviceErrors(
      data.devices.map((d) => ({
        deviceId: d.id,
        lastError: d.lastError ?? null,
        lastErrorType: d.lastErrorType ?? null,
      }))
    );
  }, [data, hydrateDeviceErrors]);

  const deleteDevice = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/devices/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(t('device.deleteFailed'));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      toast.success(t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  // 卡片顺序与侧边栏 Panes Tab 一致：先 sortOrder，再按设备名 locale 感知排序
  const devices = useMemo(() => {
    const list = data?.devices ?? [];
    return [...list].sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name, toBCP47(language), { numeric: true, sensitivity: 'base' })
    );
  }, [data?.devices, language]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:gap-4 sm:p-5" data-testid="devices-page">
      {isLoading ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">{t('common.loading')}</CardContent>
        </Card>
      ) : isError ? (
        <Card>
          <CardContent className="py-16 text-center text-sm text-destructive">{t('device.loadFailed')}</CardContent>
        </Card>
      ) : devices.length === 0 ? (
        <Card>
          <CardContent className="space-y-4 py-14 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted">
              <Monitor className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-medium">{t('device.noDevices')}</h2>
              <p className="text-sm text-muted-foreground">{t('device.addDevice')}</p>
            </div>
            <Button variant="default" data-testid="devices-add-empty" onClick={() => setShowAddModal(true)}>
              <Plus className="h-4 w-4" />
              {t('device.addDevice')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {devices.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              onEdit={() => setEditingDevice(device)}
              onDelete={() => setDeleteCandidate(device)}
            />
          ))}
        </div>
      )}

      {showAddModal && <DeviceDialog mode="create" onClose={() => setShowAddModal(false)} />}
      {editingDevice && (
        <DeviceDialog mode="edit" device={editingDevice} onClose={() => setEditingDevice(null)} />
      )}

      <AlertDialog open={deleteCandidate !== null} onOpenChange={(open) => !open && setDeleteCandidate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <Trash2 className="h-5 w-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('device.deleteConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('device.deleteDescription', { name: deleteCandidate?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!deleteCandidate || deleteDevice.isPending}
              onClick={() => {
                if (!deleteCandidate) return;
                deleteDevice.mutate(deleteCandidate.id);
                setDeleteCandidate(null);
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

interface DeviceCardProps {
  device: Device;
  onEdit: () => void;
  onDelete: () => void;
}

function DeviceCard({ device, onEdit, onDelete }: DeviceCardProps) {
  const { t } = useTranslation();

  const icon =
    device.type === 'local' ? <Monitor className="h-4 w-4" /> : <Globe className="h-4 w-4" />;
  const subtitle =
    device.type === 'local'
      ? t('device.typeLocal')
      : `${device.username ?? '-'}@${device.host ?? '-'}:${device.port ?? 22}`;

  const testConnection = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/devices/${device.id}/test-connection`, {
        method: 'POST',
      });

      let payload: unknown = null;
      try {
        payload = (await res.json()) as unknown;
      } catch {
        payload = null;
      }

      if (!res.ok) {
        const err = payload as { error?: string } | null;
        throw new Error(err?.error ?? t('common.error'));
      }

      return payload as { success?: boolean; tmuxAvailable?: boolean; message?: string };
    },
    onSuccess: (payload) => {
      toast.success(payload.message ?? t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return (
    <Card data-testid="device-card" data-device-id={device.id} data-device-name={device.name} className="overflow-hidden border-border/50">
      <CardHeader className="space-y-2 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
              {icon}
            </div>
            <div className="min-w-0 space-y-0.5">
              <CardTitle className="line-clamp-1 text-sm" title={device.name}>
                {device.name}
              </CardTitle>
              <CardDescription className="line-clamp-1 text-xs">{subtitle}</CardDescription>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    data-testid={`device-card-actions-${device.id}`}
                    aria-label={t('common.edit')}
                    title={t('common.edit')}
                  />
                }
              >
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  data-testid={`device-card-edit-${device.id}`}
                  onClick={onEdit}
                >
                  <Pencil className="h-4 w-4" />
                  {t('common.edit')}
                </DropdownMenuItem>
                {device.type === 'ssh' && (
                  <DropdownMenuItem
                    data-testid={`device-card-test-${device.id}`}
                    onClick={() => testConnection.mutate()}
                    disabled={testConnection.isPending}
                  >
                    <Zap className="h-4 w-4" />
                    {t('common.test')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-testid={`device-card-delete-${device.id}`}
                  variant="destructive"
                  onClick={onDelete}
                >
                  <Trash2 className="h-4 w-4" />
                  {t('common.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-[11px] font-normal">
            {device.type === 'local' ? t('device.typeLocal') : t('device.typeSSHBadge')}
          </Badge>
          {device.session && (
            <Badge variant="outline" className="text-[11px] font-normal">
              {device.session}
            </Badge>
          )}
          <DeviceStatusBadge deviceId={device.id} />
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        <Separator className="mb-2" />
        <div className="flex items-center justify-end">
          <Link
            to={`/devices/${device.id}`}
            data-testid={`device-card-connect-${device.id}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t('device.connect')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

interface DeviceDialogProps {
  mode: 'create' | 'edit';
  device?: Device;
  onClose: () => void;
}

function DeviceDialog({ mode, device, onClose }: DeviceDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState<DeviceFormValues>(createDefaultFormValues(device));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const isEditMode = mode === 'edit';
  const isSSH = formData.type === 'ssh';

  const createDevice = useMutation({
    mutationFn: async (payload: CreateDeviceRequest) => {
      const res = await fetch('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(await parseApiError(res, t('device.createFailed')));
      }

      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      toast.success(t('common.success'));
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const updateDevice = useMutation({
    mutationFn: async (payload: UpdateDeviceRequest) => {
      if (!device) {
        throw new Error(t('apiError.deviceNotFound'));
      }

      const res = await fetch(`/api/devices/${device.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(await parseApiError(res, t('device.updateFailed')));
      }

      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      toast.success(t('common.success'));
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);

    const validationError = validateDeviceForm(formData);
    if (validationError) {
      toast.error(t(validationError));
      return;
    }

    setIsSubmitting(true);

    try {
      if (mode === 'create') {
        await createDevice.mutateAsync(buildCreatePayload(formData));
      } else {
        await updateDevice.mutateAsync(buildUpdatePayload(formData));
      }
    } catch {
      // handled by mutation onError
    } finally {
      setIsSubmitting(false);
    }
  };

  const deviceNameInputId = `${mode}-device-name`;
  const deviceTypeSelectId = `${mode}-device-type`;
  const sshHostInputId = `${mode}-device-host`;
  const sshPortInputId = `${mode}-device-port`;
  const sshUsernameInputId = `${mode}-device-username`;
  const sessionInputId = `${mode}-device-session`;
  const authModeSelectId = `${mode}-device-auth-mode`;
  const passwordInputId = `${mode}-device-password`;
  const privateKeyTextareaId = `${mode}-device-private-key`;
  const privateKeyPassphraseInputId = `${mode}-device-private-key-passphrase`;

  const typeLabels: Record<string, string> = {
    local: t('device.typeLocal'),
    ssh: t('device.typeSSH'),
  };
  const authLabels: Record<string, string> = {
    password: t('device.authPassword'),
    key: t('device.authKey'),
    agent: t('device.authAgent'),
    configRef: t('device.authConfigRef'),
  };

  const sectionHeading = (text: string) => (
    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {text}
    </div>
  );

  const fieldLabel = (htmlFor: string, text: string, required?: boolean) => (
    <label className="block text-xs font-medium text-foreground" htmlFor={htmlFor}>
      {text}
      {required && <span className="ml-0.5 text-destructive">*</span>}
    </label>
  );

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="device-dialog" className="w-full max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEditMode ? t('device.editDevice') : t('device.addDevice')}</DialogTitle>
          <DialogDescription>
            {isEditMode ? t('device.editDeviceDescription') : t('device.addDeviceDescription')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="-mr-2 max-h-[min(70dvh,720px)] space-y-5 overflow-y-auto pr-2">
            <section className="space-y-2.5">
              {sectionHeading(t('device.sectionBasic'))}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  {fieldLabel(deviceNameInputId, t('device.name'), true)}
                  <Input
                    id={deviceNameInputId}
                    data-testid="device-name-input"
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData((d) => ({ ...d, name: e.target.value }))}
                    placeholder={t('device.namePlaceholder')}
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  {fieldLabel(deviceTypeSelectId, t('device.type'))}
                  <Select
                    value={formData.type}
                    onValueChange={(nextValue) => {
                      if (!nextValue) return;
                      const nextType = nextValue as 'local' | 'ssh';
                      setFormData((d) => ({
                        ...d,
                        type: nextType,
                        authMode:
                          nextType === 'local'
                            ? 'auto'
                            : d.authMode === 'auto'
                              ? 'agent'
                              : d.authMode,
                      }));
                    }}
                    disabled={isEditMode}
                  >
                    <SelectTrigger
                      id={deviceTypeSelectId}
                      data-testid="device-type-select"
                      className="w-full"
                    >
                      <SelectValue placeholder={t('device.type')}>
                        {(value) => typeLabels[value as string] ?? ''}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local">{t('device.typeLocal')}</SelectItem>
                      <SelectItem value="ssh">{t('device.typeSSH')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  {fieldLabel(sessionInputId, t('device.session'))}
                  <Input
                    id={sessionInputId}
                    data-testid="device-session-input"
                    type="text"
                    value={formData.session}
                    onChange={(e) => setFormData((d) => ({ ...d, session: e.target.value }))}
                    placeholder={t('device.sessionPlaceholder')}
                  />
                </div>
              </div>
            </section>

            {isSSH && (
              <>
                <section className="space-y-2.5">
                  {sectionHeading(t('device.sectionConnection'))}
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1.5 sm:col-span-2">
                      {fieldLabel(sshHostInputId, t('device.host'), true)}
                      <Input
                        id={sshHostInputId}
                        type="text"
                        value={formData.host}
                        onChange={(e) => setFormData((d) => ({ ...d, host: e.target.value }))}
                        placeholder={t('device.hostPlaceholder')}
                        aria-invalid={attempted && !formData.host.trim()}
                      />
                    </div>

                    <div className="space-y-1.5">
                      {fieldLabel(sshPortInputId, t('device.port'), true)}
                      <Input
                        id={sshPortInputId}
                        type="number"
                        value={Number.isNaN(formData.port) ? '' : formData.port}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setFormData((d) => ({
                            ...d,
                            port: raw === '' ? Number.NaN : Number.parseInt(raw, 10),
                          }));
                        }}
                        min={1}
                        max={65535}
                        aria-invalid={attempted && !isValidSshPort(formData.port)}
                      />
                    </div>

                    <div className="space-y-1.5 sm:col-span-2">
                      {fieldLabel(sshUsernameInputId, t('device.username'), true)}
                      <Input
                        id={sshUsernameInputId}
                        type="text"
                        value={formData.username}
                        onChange={(e) => setFormData((d) => ({ ...d, username: e.target.value }))}
                        placeholder={t('device.usernamePlaceholder')}
                        aria-invalid={attempted && !formData.username.trim()}
                      />
                    </div>
                  </div>
                </section>

                <section className="space-y-2.5">
                  {sectionHeading(t('device.sectionAuth'))}
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      {fieldLabel(authModeSelectId, t('device.authMode'))}
                      <Select
                        value={formData.authMode}
                        onValueChange={(nextValue) => {
                          if (!nextValue) return;
                          setFormData((d) => ({
                            ...d,
                            authMode: nextValue as CreateDeviceRequest['authMode'],
                          }));
                        }}
                      >
                        <SelectTrigger
                          id={authModeSelectId}
                          data-testid="device-auth-mode-select"
                          className="w-full"
                        >
                          <SelectValue placeholder={t('device.authMode')}>
                            {(value) => authLabels[value as string] ?? ''}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="password">{t('device.authPassword')}</SelectItem>
                          <SelectItem value="key">{t('device.authKey')}</SelectItem>
                          <SelectItem value="agent">{t('device.authAgent')}</SelectItem>
                          <SelectItem value="configRef">{t('device.authConfigRef')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {formData.authMode === 'password' && (
                      <div className="space-y-1.5">
                        {fieldLabel(passwordInputId, t('device.password'))}
                        <Input
                          id={passwordInputId}
                          type="password"
                          value={formData.password}
                          onChange={(e) =>
                            setFormData((d) => ({ ...d, password: e.target.value }))
                          }
                        />
                      </div>
                    )}

                    {formData.authMode === 'key' && (
                      <>
                        <div className="space-y-1.5">
                          {fieldLabel(privateKeyTextareaId, t('device.privateKey'))}
                          <Textarea
                            id={privateKeyTextareaId}
                            value={formData.privateKey}
                            onChange={(e) =>
                              setFormData((d) => ({ ...d, privateKey: e.target.value }))
                            }
                            className="h-28 font-mono text-xs"
                            placeholder={t('device.privateKeyPlaceholder')}
                          />
                        </div>
                        <div className="space-y-1.5">
                          {fieldLabel(privateKeyPassphraseInputId, t('device.passphrase'))}
                          <Input
                            id={privateKeyPassphraseInputId}
                            type="password"
                            value={formData.privateKeyPassphrase}
                            onChange={(e) =>
                              setFormData((d) => ({
                                ...d,
                                privateKeyPassphrase: e.target.value,
                              }))
                            }
                          />
                        </div>
                      </>
                    )}

                    {formData.authMode === 'configRef' && (
                      <div className="space-y-1.5">
                        {fieldLabel(`${mode}-device-ssh-config-ref`, t('device.authConfigRef'), true)}
                        <Input
                          id={`${mode}-device-ssh-config-ref`}
                          data-testid="device-ssh-config-ref-input"
                          type="text"
                          value={formData.sshConfigRef}
                          onChange={(e) =>
                            setFormData((d) => ({ ...d, sshConfigRef: e.target.value }))
                          }
                          placeholder={t('device.sshConfigRefPlaceholder')}
                          aria-invalid={attempted && !formData.sshConfigRef.trim()}
                        />
                        <p className="text-[11px] text-muted-foreground">
                          {t('device.sshConfigRefHint')}
                        </p>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="default"
              data-testid="device-dialog-save"
              disabled={isSubmitting}
            >
              {isSubmitting ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Page title component
export function PageTitle() {
  const { t } = useTranslation();
  return <>{t('sidebar.manageDevices')}</>;
}

// Page actions component
export function PageActions() {
  const { t } = useTranslation();
  
  const handleAdd = () => {
    window.dispatchEvent(new CustomEvent('tmex:open-add-device'));
  };
  
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      data-testid="devices-add"
      onClick={handleAdd}
      aria-label={t('sidebar.addDevice')}
      title={t('sidebar.addDevice')}
    >
      <Plus className="h-4 w-4" />
    </Button>
  );
}
