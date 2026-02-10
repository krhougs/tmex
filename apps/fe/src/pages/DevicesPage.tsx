import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDeviceRequest, Device } from '@tmex/shared';
import { Globe, Monitor, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
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

export function DevicesPage() {
  const [showAddModal, setShowAddModal] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetch('/api/devices', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json() as Promise<{ devices: Device[] }>;
    },
  });

  const deleteDevice = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/devices/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to delete');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
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
              onDelete={() => deleteDevice.mutate(device.id)}
            />
          ))}
        </div>
      )}

      {showAddModal && <AddDeviceDialog onClose={() => setShowAddModal(false)} />}
    </div>
  );
}

// ==================== 子组件 ====================

interface DeviceCardProps {
  device: Device;
  onDelete: () => void;
}

function DeviceCard({ device, onDelete }: DeviceCardProps) {
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

interface AddDeviceDialogProps {
  onClose: () => void;
}

function AddDeviceDialog({ onClose }: AddDeviceDialogProps) {
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState<CreateDeviceRequest>({
    name: '',
    type: 'local',
    authMode: 'password',
    host: '',
    port: 22,
    username: '',
    session: 'tmex',
    password: '',
    privateKey: '',
  });

  const createDevice = useMutation({
    mutationFn: async (data: CreateDeviceRequest) => {
      const res = await fetch('/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create device');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
      onClose();
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      await createDevice.mutateAsync(formData);
    } catch (err) {
      console.error(err);
    }
    setIsSubmitting(false);
  };

  const isSSH = formData.type === 'ssh';

  const deviceNameInputId = 'add-device-name';
  const deviceTypeSelectId = 'add-device-type';
  const sshHostInputId = 'add-device-host';
  const sshPortInputId = 'add-device-port';
  const sshUsernameInputId = 'add-device-username';
  const sessionInputId = 'add-device-session';
  const authModeSelectId = 'add-device-auth-mode';
  const passwordInputId = 'add-device-password';
  const privateKeyTextareaId = 'add-device-private-key';
  const privateKeyPassphraseInputId = 'add-device-private-key-passphrase';

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-full max-w-lg">
        <DialogHeader>
          <DialogTitle>添加设备</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4">
            {/* 基本信息 */}
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
                onChange={(e) =>
                  setFormData((d) => ({ ...d, type: e.target.value as 'local' | 'ssh' }))
                }
              >
                <SelectOption value="local">本地设备</SelectOption>
                <SelectOption value="ssh">SSH 远程设备</SelectOption>
              </Select>
            </div>

            {/* SSH 配置 */}
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
                      required={isSSH}
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
                        setFormData((d) => ({ ...d, port: Number.parseInt(e.target.value) }))
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

            {/* Session 配置 */}
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

            {/* 认证方式 */}
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
                {isSSH && <SelectOption value="configRef">SSH Config</SelectOption>}
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
                  <label
                    className="block text-sm font-medium mb-1.5"
                    htmlFor={privateKeyTextareaId}
                  >
                    私钥
                  </label>
                  <Textarea
                    id={privateKeyTextareaId}
                    value={formData.privateKey}
                    onChange={(e) => setFormData((d) => ({ ...d, privateKey: e.target.value }))}
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
          </DialogBody>

          <DialogFooter className="px-4 pb-4">
            <Button type="button" variant="default" className="flex-1" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" variant="primary" className="flex-1" disabled={isSubmitting}>
              {isSubmitting ? '添加中...' : '添加'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
