import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useTmuxStore } from '@/stores/tmux';
import { AlertCircle, RefreshCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const ERROR_TYPE_TO_BADGE_KEY: Record<string, string> = {
  auth_failed: 'authFailed',
  agent_unavailable: 'agentUnavailable',
  agent_no_identity: 'agentNoIdentity',
  ssh_config_ref_not_supported: 'configRefNotSupported',
  network_unreachable: 'networkUnreachable',
  connection_refused: 'connectionRefused',
  timeout: 'timeout',
  host_not_found: 'hostNotFound',
  handshake_failed: 'handshakeFailed',
  tmux_unavailable: 'tmuxUnavailable',
  connection_closed: 'connectionClosed',
};

interface DeviceStatusBadgeProps {
  deviceId: string;
  className?: string;
}

export function DeviceStatusBadge({ deviceId, className }: DeviceStatusBadgeProps) {
  const { t } = useTranslation();
  const reconnecting = useTmuxStore((state) => state.deviceReconnecting[deviceId]);
  const error = useTmuxStore((state) => state.deviceErrors[deviceId]);

  if (reconnecting) {
    return (
      <Badge
        variant="outline"
        title={reconnecting.message}
        className={cn(
          'h-5 gap-1 border-amber-400/40 bg-amber-500/10 px-1.5 text-[10px] font-normal text-amber-700 dark:text-amber-300',
          className
        )}
      >
        <RefreshCcw className="h-3 w-3 animate-spin" />
        <span className="truncate max-w-[120px]">{reconnecting.message}</span>
      </Badge>
    );
  }

  if (error) {
    const badgeKey = ERROR_TYPE_TO_BADGE_KEY[error.type] ?? 'unknown';
    const label = t(`deviceStatus.errorBadge.${badgeKey}` as any);
    const tooltip = [label, error.message, error.rawMessage].filter(Boolean).join('\n');

    return (
      <Badge
        variant="outline"
        title={tooltip}
        className={cn(
          'h-5 gap-1 border-red-400/40 bg-red-500/10 px-1.5 text-[10px] font-normal text-red-700 dark:text-red-300',
          className
        )}
      >
        <AlertCircle className="h-3 w-3" />
        <span className="truncate max-w-[120px]">{label}</span>
      </Badge>
    );
  }

  return null;
}
