import { toast } from 'sonner';

import { Progress } from '@/components/ui/progress';
import i18n from '@/i18n';
import { cn } from '@/lib/utils';
import type { TransferProgress } from './api';
import { formatBytes } from './format';

type Status = 'working' | 'success' | 'error';

interface ToastModel {
  fileName: string;
  status: Status;
  phase: TransferProgress['phase'];
  pct: number;
  sent: number;
  total: number;
  rate?: string;
  message?: string;
  onCancel?: () => void;
}

function phaseLabel(phase: TransferProgress['phase']): string {
  switch (phase) {
    case 'upload':
      return i18n.t('files.transfer.uploadingToServer');
    case 'device':
      return i18n.t('files.transfer.uploadingToDevice');
    case 'preparing':
      return i18n.t('files.transfer.preparing');
    default:
      return i18n.t('files.transfer.downloading');
  }
}

function ToastBody({ m }: { m: ToastModel }) {
  return (
    <div className="flex w-full flex-col gap-1.5" data-testid="transfer-toast">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.fileName}</span>
        {m.status === 'working' && m.onCancel && (
          <button
            type="button"
            onClick={m.onCancel}
            data-testid="transfer-cancel"
            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {i18n.t('files.transfer.cancel')}
          </button>
        )}
      </div>
      {m.status === 'working' ? (
        <>
          <Progress value={m.pct} />
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">{phaseLabel(m.phase)}</span>
            <span className="shrink-0 tabular-nums">
              {m.rate ?? ''}
              {m.total > 0 ? ` · ${formatBytes(m.sent)} / ${formatBytes(m.total)}` : ''}
            </span>
          </div>
        </>
      ) : (
        <div
          className={cn(
            'text-xs',
            m.status === 'error' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {m.message}
        </div>
      )}
    </div>
  );
}

export interface TransferToast {
  update: (p: TransferProgress) => void;
  success: (message: string) => void;
  fail: (message: string) => void;
}

// 启动一个传输进度 Toast。工作态：duration:Infinity + dismissible:false（不自动消失、不可手动关闭，
// 唯一中止途径是取消按钮）。完成/失败后才放开（成功短暂停留后自动消失；失败保留可手动关闭）。
export function startTransferToast(fileName: string, onCancel: () => void): TransferToast {
  const id = `transfer-${fileName}-${performance.now()}`;
  const model: ToastModel = {
    fileName,
    status: 'working',
    phase: 'upload',
    pct: 0,
    sent: 0,
    total: 0,
    onCancel,
  };
  let lastRender = 0;

  const render = (opts?: { duration?: number; dismissible?: boolean }) => {
    toast.custom(() => <ToastBody m={{ ...model }} />, {
      id,
      duration: opts?.duration ?? Number.POSITIVE_INFINITY,
      dismissible: opts?.dismissible ?? false,
    });
  };
  render();

  return {
    update(p) {
      model.phase = p.phase;
      model.sent = p.sent;
      model.total = p.total;
      model.rate = p.rate;
      model.pct = p.total > 0 ? Math.round((p.sent / p.total) * 100) : model.pct;
      const now = performance.now();
      if (now - lastRender < 100) return; // 节流，避免高频重渲染
      lastRender = now;
      render();
    },
    success(message) {
      model.status = 'success';
      model.message = message;
      model.onCancel = undefined;
      render({ duration: 4000, dismissible: true });
    },
    fail(message) {
      model.status = 'error';
      model.message = message;
      model.onCancel = undefined;
      render({ duration: Number.POSITIVE_INFINITY, dismissible: true });
    },
  };
}
