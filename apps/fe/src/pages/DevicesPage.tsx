import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDeviceRequest, Device, UpdateDeviceRequest } from '@tmex/shared';
import { Globe, Monitor, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectOption,
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

  const { data, isLoading } = useQuery({
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
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{t('device.title')}</h1>
        <Button variant="primary" data-testid="devices-add" onClick={() => setShowAddModal(true)}>
          <Plus className="h-4 w-4" />
          {t('device.addDevice')}
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)]">{t('common.loading')}</div>
      ) : devices.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12">
            <div className="text-4xl mb-4">🖥️</div>
            <h3 className="text-lg font-medium mb-2">{t('device.noDevices')}</h3>
            <p className="text-[var(--color-text-secondary)] mb-4">{t('device.typeLocal')} / SSH {t('device.type')}</p>
            <Button variant="primary" data-testid="devices-add-empty" onClick={() => setShowAddModal(true)}>
              {t('device.addDevice')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
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
    device.type === 'local' ? <Monitor className="h-6 w-6" /> : <Globe className="h-6 w-6" />;
  const subtitle =
    device.type === 'local' ? t('device.typeLocal') : `${device.username}@${device.host}:${device.port}`;

  return (
    <Card data-testid="device-card" data-device-id={device.id} data-device-name={device.name}>
      <CardHeader>
        <div className="text-[var(--color-accent)]">{icon}</div>

        <div className="flex-1 min-w-0">
          <CardTitle>{device.name}</CardTitle>
          <CardDescription>{subtitle}</CardDescription>
          {device.session && device.session !== 'tmex' && (
            <p className="text-xs text-[var(--color-text-muted)] mt-1">Session: {device.session}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="default" size="sm" onClick={onEdit} title={t('device.editDevice')}>
            <Pencil className="h-4 w-4" />
          </Button>

          <Button variant="primary" size="sm" asChild>
            <Link data-testid={`device-connect-${device.id}`} to={`/devices/${device.id}`}>{t('device.connect')}</Link>
          </Button>

          <Button variant="danger" size="sm" onClick={onDelete} title={t('common.delete')}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState<DeviceFormValues>(() => createDefaultFormValues(device));

  useEffect(() => {
    setFormData(createDefaultFormValues(device));
  }, [device]);

  const isSSH = formData.type === 'ssh';
  const isEditMode = mode === 'edit';

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
      <DialogContent className="w-full max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditMode ? t('device.editDevice') : t('device.addDevice')}</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5" htmlFor={deviceNameInputId}>
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

            <div>
              <label className="block text-sm font-medium mb-1.5" htmlFor={deviceTypeSelectId}>
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

            {isSSH && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-sm font-medium mb-1.5" htmlFor={sshHostInputId}>
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

                  <div>
                    <label className="block text-sm font-medium mb-1.5" htmlFor={sshPortInputId}>
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
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1.5" htmlFor={sshUsernameInputId}>
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
              </>
            )}

            <div>
              <label className="block text-sm font-medium mb-1.5" htmlFor={sessionInputId}>
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
              <p className="text-xs text-[var(--color-text-muted)] mt-1">
                &quot;tmex&quot;
              </p>
            </div>

            {isSSH && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-1.5" htmlFor={authModeSelectId}>
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
                  <div>
                    <label className="block text-sm font-medium mb-1.5" htmlFor={passwordInputId}>
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
                    <div>
                      <label className="block text-sm font-medium mb-1.5" htmlFor={privateKeyTextareaId}>
                        {t('device.privateKey')}
                      </label>
                      <Textarea
                        id={privateKeyTextareaId}
                        value={formData.privateKey}
                        onChange={(e) =>
                          setFormData((d) => ({ ...d, privateKey: e.target.value }))
                        }
                        className="h-24 font-mono text-xs"
                        placeholder={t('device.privateKeyPlaceholder')}
                      />
                    </div>
                    <div>
                      <label
                        className="block text-sm font-medium mb-1.5"
                        htmlFor={privateKeyPassphraseInputId}
                      >
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
              </>
            )}
          </DialogBody>

          <DialogFooter className="px-4 pb-4">
            <Button type="button" variant="default" className="flex-1" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" className="flex-1" data-testid="device-dialog-save" disabled={isSubmitting}>
              {isSubmitting ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
