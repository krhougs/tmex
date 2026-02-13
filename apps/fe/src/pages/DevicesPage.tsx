import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDeviceRequest, Device, UpdateDeviceRequest } from '@tmex/shared';
import { Globe, Monitor, MoreHorizontal, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { type FormEvent, useState, useEffect } from 'react';
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
      username: '',
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

  const payload: CreateDeviceRequest = {
    name: values.name.trim(),
    type: 'ssh',
    host: normalizeText(values.host),
    port: values.port,
    username: normalizeText(values.username),
    sshConfigRef: normalizeText(values.sshConfigRef),
    session: normalizeText(values.session) ?? 'tmex',
    authMode: values.authMode,
  };

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

  const payload: UpdateDeviceRequest = {
    name: values.name.trim(),
    host: normalizeText(values.host),
    port: values.port,
    username: normalizeText(values.username),
    sshConfigRef: normalizeText(values.sshConfigRef),
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
      return res.json() as Promise<{ devices: Device[] }>;
    },
    throwOnError: false,
  });

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

  const devices = data?.devices ?? [];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:gap-4 sm:p-5" data-testid="devices-page">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{t('device.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('device.typeLocal')} / SSH · {devices.length}
          </p>
        </div>
        <Button variant="default" data-testid="devices-add" onClick={() => setShowAddModal(true)}>
          <Plus className="h-4 w-4" />
          {t('device.addDevice')}
        </Button>
      </header>

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
            <AlertDialogMedia>
              <Trash2 className="h-5 w-5 text-muted-foreground" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('device.deleteConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>{deleteCandidate?.name ?? ''}</AlertDialogDescription>
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
    device.type === 'local' ? <Monitor className="h-5 w-5" /> : <Globe className="h-5 w-5" />;
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
    <Card data-testid="device-card" data-device-id={device.id} data-device-name={device.name} className="overflow-hidden">
      <CardHeader className="space-y-3 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
              {icon}
            </div>
            <div className="min-w-0 space-y-1">
              <CardTitle className="line-clamp-1 text-base" title={device.name}>
                {device.name}
              </CardTitle>
              <CardDescription className="line-clamp-1">{subtitle}</CardDescription>
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

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{device.type === 'local' ? t('device.typeLocal') : 'SSH'}</Badge>
          {device.session && <Badge variant="outline">{device.session}</Badge>}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        <Separator className="mb-3" />
        <div className="flex items-center justify-end">
          <Link
            to={`/devices/${device.id}`}
            data-testid={`device-card-connect-${device.id}`}
            className={buttonVariants({ variant: 'default', size: 'sm' })}
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

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="device-dialog" className="w-full max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEditMode ? t('device.editDevice') : t('device.addDevice')}</DialogTitle>
          <DialogDescription>
            {isEditMode ? t('device.editDevice') : t('device.addDevice')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="max-h-[min(70vh,720px)] space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <label className="block text-sm font-medium" htmlFor={deviceNameInputId}>
                  {t('device.name')}
                </label>
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
                <label className="block text-sm font-medium" htmlFor={deviceTypeSelectId}>
                  {t('device.type')}
                </label>
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
                            ? 'password'
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
                    <SelectValue placeholder={t('device.type')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">{t('device.typeLocal')}</SelectItem>
                    <SelectItem value="ssh">SSH {t('device.type')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <label className="block text-sm font-medium" htmlFor={sessionInputId}>
                  {t('device.session')}
                </label>
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

            {isSSH && (
              <>
                <Separator />
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5 sm:col-span-2">
                    <label className="block text-sm font-medium" htmlFor={sshHostInputId}>
                      {t('device.host')}
                    </label>
                    <Input
                      id={sshHostInputId}
                      type="text"
                      value={formData.host}
                      onChange={(e) => setFormData((d) => ({ ...d, host: e.target.value }))}
                      placeholder={t('device.hostPlaceholder')}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium" htmlFor={sshPortInputId}>
                      {t('device.port')}
                    </label>
                    <Input
                      id={sshPortInputId}
                      type="number"
                      value={formData.port}
                      onChange={(e) =>
                        setFormData((d) => ({
                          ...d,
                          port: Number.parseInt(e.target.value || '22', 10),
                        }))
                      }
                      min={1}
                      max={65535}
                    />
                  </div>

                  <div className="space-y-1.5 sm:col-span-2">
                    <label className="block text-sm font-medium" htmlFor={sshUsernameInputId}>
                      {t('device.username')}
                    </label>
                    <Input
                      id={sshUsernameInputId}
                      type="text"
                      value={formData.username}
                      onChange={(e) => setFormData((d) => ({ ...d, username: e.target.value }))}
                      placeholder={t('device.usernamePlaceholder')}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium" htmlFor={`${mode}-device-ssh-config-ref`}>
                      SSH Config
                    </label>
                    <Input
                      id={`${mode}-device-ssh-config-ref`}
                      type="text"
                      value={formData.sshConfigRef}
                      onChange={(e) => setFormData((d) => ({ ...d, sshConfigRef: e.target.value }))}
                      placeholder="~/.ssh/config"
                    />
                  </div>
                </div>

                <Separator />
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium" htmlFor={authModeSelectId}>
                      {t('device.authMode')}
                    </label>
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
                      <SelectTrigger id={authModeSelectId} className="w-full">
                        <SelectValue placeholder={t('device.authMode')} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="password">{t('device.authPassword')}</SelectItem>
                        <SelectItem value="key">{t('device.authKey')}</SelectItem>
                        <SelectItem value="agent">{t('device.authAgent')}</SelectItem>
                        <SelectItem value="configRef">SSH Config</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {formData.authMode === 'password' && (
                    <div className="space-y-1.5">
                      <label className="block text-sm font-medium" htmlFor={passwordInputId}>
                        {t('device.password')}
                      </label>
                      <Input
                        id={passwordInputId}
                        type="password"
                        value={formData.password}
                        onChange={(e) => setFormData((d) => ({ ...d, password: e.target.value }))}
                      />
                    </div>
                  )}

                  {formData.authMode === 'key' && (
                    <>
                      <div className="space-y-1.5">
                        <label className="block text-sm font-medium" htmlFor={privateKeyTextareaId}>
                          {t('device.privateKey')}
                        </label>
                        <Textarea
                          id={privateKeyTextareaId}
                          value={formData.privateKey}
                          onChange={(e) => setFormData((d) => ({ ...d, privateKey: e.target.value }))}
                          className="h-28 font-mono text-xs"
                          placeholder={t('device.privateKeyPlaceholder')}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="block text-sm font-medium" htmlFor={privateKeyPassphraseInputId}>
                          {t('device.passphrase')}
                        </label>
                        <Input
                          id={privateKeyPassphraseInputId}
                          type="password"
                          value={formData.privateKeyPassphrase}
                          onChange={(e) =>
                            setFormData((d) => ({ ...d, privateKeyPassphrase: e.target.value }))
                          }
                        />
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="default"
              className="flex-1"
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
      onClick={handleAdd}
      aria-label={t('sidebar.addDevice')}
      title={t('sidebar.addDevice')}
    >
      <Plus className="h-4 w-4" />
    </Button>
  );
}
