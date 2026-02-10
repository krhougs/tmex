import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDeviceRequest, Device } from '@tmex/shared';
import { useState } from 'react';
import { Link } from 'react-router';

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
        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="btn btn-primary"
          aria-label="添加设备"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 2a1 1 0 011 1v4h4a1 1 0 110 2H9v4a1 1 0 11-2 0V9H3a1 1 0 110-2h4V3a1 1 0 011-1z" />
          </svg>
          添加设备
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-text-secondary">加载中...</div>
      ) : devices.length === 0 ? (
        <div className="text-center py-12 bg-bg-secondary rounded-lg border border-border">
          <div className="text-4xl mb-4">🖥️</div>
          <h3 className="text-lg font-medium mb-2">暂无设备</h3>
          <p className="text-text-secondary mb-4">添加本地或 SSH 设备开始使用</p>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="btn btn-primary"
            aria-label="添加第一个设备"
          >
            添加第一个设备
          </button>
        </div>
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

      {showAddModal && <AddDeviceModal onClose={() => setShowAddModal(false)} />}
    </div>
  );
}

// ==================== 子组件 ====================

interface DeviceCardProps {
  device: Device;
  onDelete: () => void;
}

function DeviceCard({ device, onDelete }: DeviceCardProps) {
  const icon = device.type === 'local' ? '🖥️' : '🌐';
  const subtitle =
    device.type === 'local' ? '本地设备' : `${device.username}@${device.host}:${device.port}`;
  const deleteLabel = `删除设备：${device.name}`;

  return (
    <div className="bg-bg-secondary rounded-lg border border-border p-4 flex items-center gap-4">
      <div className="text-2xl">{icon}</div>

      <div className="flex-1 min-w-0">
        <h3 className="font-medium truncate">{device.name}</h3>
        <p className="text-sm text-text-secondary truncate">{subtitle}</p>
      </div>

      <div className="flex items-center gap-2">
        <Link to={`/devices/${device.id}`} className="btn btn-primary btn-sm">
          连接
        </Link>

        <button
          type="button"
          onClick={onDelete}
          className="btn btn-danger btn-sm"
          title="删除"
          aria-label={deleteLabel}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M6.5 1h3a.5.5 0 01.5.5v1H6v-1a.5.5 0 01.5-.5zM5 3v10a2 2 0 002 2h2a2 2 0 002-2V3H5z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

interface AddDeviceModalProps {
  onClose: () => void;
}

function AddDeviceModal({ onClose }: AddDeviceModalProps) {
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nameInputId = 'add-device-name';
  const typeSelectId = 'add-device-type';
  const hostInputId = 'add-device-host';
  const portInputId = 'add-device-port';
  const usernameInputId = 'add-device-username';
  const authModeSelectId = 'add-device-auth-mode';
  const passwordInputId = 'add-device-password';
  const privateKeyTextareaId = 'add-device-private-key';
  const privateKeyPassphraseInputId = 'add-device-private-key-passphrase';
  const [formData, setFormData] = useState<CreateDeviceRequest>({
    name: '',
    type: 'local',
    authMode: 'password',
    host: '',
    port: 22,
    username: '',
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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-bg-secondary rounded-lg border border-border w-full max-w-lg max-h-[90vh] overflow-auto">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-semibold">添加设备</h2>
          <button type="button" onClick={onClose} className="text-text-secondary hover:text-text">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* 基本信息 */}
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor={nameInputId}>
              设备名称
            </label>
            <input
              id={nameInputId}
              type="text"
              value={formData.name}
              onChange={(e) => setFormData((d) => ({ ...d, name: e.target.value }))}
              className="input w-full"
              placeholder="例如：我的服务器"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" htmlFor={typeSelectId}>
              类型
            </label>
            <select
              id={typeSelectId}
              value={formData.type}
              onChange={(e) =>
                setFormData((d) => ({ ...d, type: e.target.value as 'local' | 'ssh' }))
              }
              className="select w-full"
            >
              <option value="local">本地设备</option>
              <option value="ssh">SSH 远程设备</option>
            </select>
          </div>

          {/* SSH 配置 */}
          {isSSH && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-sm font-medium mb-1" htmlFor={hostInputId}>
                    主机
                  </label>
                  <input
                    id={hostInputId}
                    type="text"
                    value={formData.host}
                    onChange={(e) => setFormData((d) => ({ ...d, host: e.target.value }))}
                    className="input w-full"
                    placeholder="example.com"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" htmlFor={portInputId}>
                    端口
                  </label>
                  <input
                    id={portInputId}
                    type="number"
                    value={formData.port}
                    onChange={(e) =>
                      setFormData((d) => ({ ...d, port: Number.parseInt(e.target.value) }))
                    }
                    className="input w-full"
                    min={1}
                    max={65535}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1" htmlFor={usernameInputId}>
                  用户名
                </label>
                <input
                  id={usernameInputId}
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData((d) => ({ ...d, username: e.target.value }))}
                  className="input w-full"
                  placeholder="root"
                />
              </div>
            </>
          )}

          {/* 认证方式 */}
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor={authModeSelectId}>
              认证方式
            </label>
            <select
              id={authModeSelectId}
              value={formData.authMode}
              onChange={(e) =>
                setFormData((d) => ({
                  ...d,
                  authMode: e.target.value as CreateDeviceRequest['authMode'],
                }))
              }
              className="select w-full"
            >
              <option value="password">密码</option>
              <option value="key">私钥</option>
              <option value="agent">SSH Agent</option>
              {isSSH && <option value="configRef">SSH Config</option>}
            </select>
          </div>

          {formData.authMode === 'password' && (
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor={passwordInputId}>
                密码
              </label>
              <input
                id={passwordInputId}
                type="password"
                value={formData.password}
                onChange={(e) => setFormData((d) => ({ ...d, password: e.target.value }))}
                className="input w-full"
              />
            </div>
          )}

          {formData.authMode === 'key' && (
            <>
              <div>
                <label className="block text-sm font-medium mb-1" htmlFor={privateKeyTextareaId}>
                  私钥
                </label>
                <textarea
                  id={privateKeyTextareaId}
                  value={formData.privateKey}
                  onChange={(e) => setFormData((d) => ({ ...d, privateKey: e.target.value }))}
                  className="input w-full h-24 font-mono text-xs"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </div>
              <div>
                <label
                  className="block text-sm font-medium mb-1"
                  htmlFor={privateKeyPassphraseInputId}
                >
                  私钥密码（可选）
                </label>
                <input
                  id={privateKeyPassphraseInputId}
                  type="password"
                  value={formData.privateKeyPassphrase}
                  onChange={(e) =>
                    setFormData((d) => ({ ...d, privateKeyPassphrase: e.target.value }))
                  }
                  className="input w-full"
                />
              </div>
            </>
          )}

          <div className="flex gap-3 pt-4">
            <button type="button" onClick={onClose} className="btn flex-1">
              取消
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="btn btn-primary flex-1 disabled:opacity-50"
            >
              {isSubmitting ? '添加中...' : '添加'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
