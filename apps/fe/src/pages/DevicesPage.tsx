import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDeviceRequest, Device, UpdateDeviceRequest } from '@tmex/shared';
import { Globe, Monitor, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
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
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices');
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json() as Promise<{ devices: Device[] }>;
    },
    throwOnError: false,
  });

  const deleteDevice = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/devices/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      toast.success('设备已删除');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '删除设备失败');
    },
  });

  const devices = data?.devices ?? [];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">设备管理</h1>
        <Button variant="primary" onClick={() => setShowAddModal(true)}>
          <Plus className="h-4 w-4" />
          添加设备
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-[var(--color-text-secondary)]">加载中...</div>
      ) : devices.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12">
            <div className="text-4xl mb-4">🖥️</div>
            <h3 className="text-lg font-medium mb-2">暂无设备</h3>
            <p className="text-[var(--color-text-secondary)] mb-4">添加本地或 SSH 设备开始使用</p>
            <Button variant="primary" onClick={() => setShowAddModal(true)}>
              添加第一个设备
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
  const icon =
    device.type === 'local' ? <Monitor className="h-6 w-6" /> : <Globe className="h-6 w-6" />;
  const subtitle =
    device.type === 'local' ? '本地设备' : `${device.username}@${device.host}:${device.port}`;

  return (
    <Card>
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
          <Button variant="default" size="sm" onClick={onEdit} title="修改设备">
            <Pencil className="h-4 w-4" />
          </Button>

          <Button variant="primary" size="sm" asChild>
            <Link to={`/devices/${device.id}`}>连接</Link>
          </Button>

          <Button variant="danger" size="sm" onClick={onDelete} title="删除">
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
        throw new Error(await parseApiError(res, '创建设备失败'));
      }

      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      toast.success('设备已创建');
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '创建设备失败');
    },
  });

  const updateDevice = useMutation({
    mutationFn: async (payload: UpdateDeviceRequest) => {
      if (!device) {
        throw new Error('设备不存在');
      }

      const res = await fetch(`/api/devices/${device.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(await parseApiError(res, '更新设备失败'));
      }

      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      toast.success('设备已更新');
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '更新设备失败');
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
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-full max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditMode ? '修改设备' : '添加设备'}</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5" htmlFor={deviceNameInputId}>
                设备名称
              </label>
              <Input
                id={deviceNameInputId}
                type="text"
                value={formData.name}
                onChange={(e) => setFormData((d) => ({ ...d, name: e.target.value }))}
                placeholder="例如：我的服务器"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5" htmlFor={deviceTypeSelectId}>
                类型
              </label>
              <Select
                id={deviceTypeSelectId}
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
                <SelectOption value="local">本地设备</SelectOption>
                <SelectOption value="ssh">SSH 远程设备</SelectOption>
              </Select>
            </div>

            {isSSH && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-sm font-medium mb-1.5" htmlFor={sshHostInputId}>
                      主机
                    </label>
                    <Input
                      id={sshHostInputId}
                      type="text"
                      value={formData.host}
                      onChange={(e) => setFormData((d) => ({ ...d, host: e.target.value }))}
                      placeholder="example.com"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1.5" htmlFor={sshPortInputId}>
                      端口
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
                    用户名
                  </label>
                  <Input
                    id={sshUsernameInputId}
                    type="text"
                    value={formData.username}
                    onChange={(e) => setFormData((d) => ({ ...d, username: e.target.value }))}
                    placeholder="root"
                  />
                </div>
              </>
            )}

            <div>
              <label className="block text-sm font-medium mb-1.5" htmlFor={sessionInputId}>
                Tmux 会话名称
              </label>
              <Input
                id={sessionInputId}
                type="text"
                value={formData.session}
                onChange={(e) => setFormData((d) => ({ ...d, session: e.target.value }))}
                placeholder="tmex"
              />
              <p className="text-xs text-[var(--color-text-muted)] mt-1">
                留空将使用默认值 &quot;tmex&quot;
              </p>
            </div>

            {isSSH && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-1.5" htmlFor={authModeSelectId}>
                    认证方式
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
                    <SelectOption value="password">密码</SelectOption>
                    <SelectOption value="key">私钥</SelectOption>
                    <SelectOption value="agent">SSH Agent</SelectOption>
                    <SelectOption value="configRef">SSH Config</SelectOption>
                  </Select>
                </div>

                {formData.authMode === 'password' && (
                  <div>
                    <label className="block text-sm font-medium mb-1.5" htmlFor={passwordInputId}>
                      密码
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
                        私钥
                      </label>
                      <Textarea
                        id={privateKeyTextareaId}
                        value={formData.privateKey}
                        onChange={(e) =>
                          setFormData((d) => ({ ...d, privateKey: e.target.value }))
                        }
                        className="h-24 font-mono text-xs"
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      />
                    </div>
                    <div>
                      <label
                        className="block text-sm font-medium mb-1.5"
                        htmlFor={privateKeyPassphraseInputId}
                      >
                        私钥密码（可选）
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
              取消
            </Button>
            <Button type="submit" variant="primary" className="flex-1" disabled={isSubmitting}>
              {isSubmitting ? (isEditMode ? '保存中...' : '添加中...') : isEditMode ? '保存' : '添加'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
