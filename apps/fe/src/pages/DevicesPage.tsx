import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDeviceRequest, Device, UpdateDeviceRequest } from '@tmex/shared';
import { Globe, Monitor, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectOption,
  Separator,
  Textarea,
} from '../components/ui';

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

export function DevicesPage() {
  const { t } = useTranslation();
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const queryClient = useQueryClient();

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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-6" data-testid="devices-page">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{t('device.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('device.typeLocal')} / SSH · {devices.length}
          </p>
        </div>
        <Button variant="primary" data-testid="devices-add" onClick={() => setShowAddModal(true)}>
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
            <Button variant="primary" data-testid="devices-add-empty" onClick={() => setShowAddModal(true)}>
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
              onDelete={() => deleteDevice.mutate(device.id)}
            />
          ))}
        </div>
      )}

      {showAddModal && <DeviceDialog mode="create" onClose={() => setShowAddModal(false)} />}
      {editingDevice && (
        <DeviceDialog mode="edit" device={editingDevice} onClose={() => setEditingDevice(null)} />
      )}
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
            <Button variant="default" size="sm" onClick={onEdit} title={t('device.editDevice')}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button variant="danger" size="sm" onClick={onDelete} title={t('common.delete')}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
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
            className="text-xs font-medium text-primary transition-colors hover:text-primary/80 hover:underline"
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
    <Dialog open={true} onOpenChange={(open) => !open && onClose()} data-testid="device-dialog">
      <DialogContent className="w-full max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEditMode ? t('device.editDevice') : t('device.addDevice')}</DialogTitle>
          <DialogDescription>
            {isEditMode ? t('device.editDevice') : t('device.addDevice')}
          </DialogDescription>
          <DialogCloseButton />
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <DialogBody className="max-h-[min(70vh,720px)] overflow-y-auto pr-1 space-y-4">
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
                  id={deviceTypeSelectId}
                  data-testid="device-type-select"
                  value={formData.type}
                  onChange={(e) => {
                    const nextType = e.target.value as 'local' | 'ssh';
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
                  <SelectOption value="local">{t('device.typeLocal')}</SelectOption>
                  <SelectOption value="ssh">SSH {t('device.type')}</SelectOption>
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
                      id={authModeSelectId}
                      value={formData.authMode}
                      onChange={(e) =>
                        setFormData((d) => ({
                          ...d,
                          authMode: e.target.value as CreateDeviceRequest['authMode'],
                        }))
                      }
                    >
                      <SelectOption value="password">{t('device.authPassword')}</SelectOption>
                      <SelectOption value="key">{t('device.authKey')}</SelectOption>
                      <SelectOption value="agent">{t('device.authAgent')}</SelectOption>
                      <SelectOption value="configRef">SSH Config</SelectOption>
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
          </DialogBody>

          <DialogFooter className="px-4 pb-4">
            <Button type="button" variant="default" className="flex-1" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
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
