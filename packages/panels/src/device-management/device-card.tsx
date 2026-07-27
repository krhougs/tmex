// 设备卡片：图标/副标题、类型与 session 徽标、状态徽标，菜单含编辑/测试连接（仅 SSH）/删除。

import { useMutation } from '@tanstack/react-query';
import { testDeviceConnection } from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@tmex/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { Globe, Monitor, MoreHorizontal, Pencil, Trash2, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@tmex/ui/toast';
import { DeviceStatusBadge } from '../device-status-badge';

export interface DeviceCardProps {
  device: Device;
  onEdit: () => void;
  onDelete: () => void;
}

export function DeviceCard({ device, onEdit, onDelete }: DeviceCardProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();

  const icon =
    device.type === 'local' ? <Monitor className="h-4 w-4" /> : <Globe className="h-4 w-4" />;
  const subtitle =
    device.type === 'local'
      ? t('device.typeLocal')
      : `${device.username ?? '-'}@${device.host ?? '-'}:${device.port ?? 22}`;

  const testConnection = useMutation({
    mutationFn: () => testDeviceConnection(device.id, t('common.error'), runtime.apiClient),
    onSuccess: (payload) => {
      toast.success(payload.message ?? t('common.success'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  return (
    <Card
      data-testid="device-card"
      data-device-id={device.id}
      data-device-name={device.name}
      className="overflow-hidden border-border/50"
    >
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
                <DropdownMenuItem data-testid={`device-card-edit-${device.id}`} onClick={onEdit}>
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
    </Card>
  );
}
