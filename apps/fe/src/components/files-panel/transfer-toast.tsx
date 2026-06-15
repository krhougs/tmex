import { toast } from 'sonner';

import { Progress } from '@/components/ui/progress';
import i18n from '@/i18n';
import type { TransferProgress } from './api';
import { formatBytes } from './format';

interface WorkingModel {
  fileName: string;
  phase: TransferProgress['phase'];
  pct: number;
  sent: number;
  total: number;
  rate?: string;
  onCancel: () => void;
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

// 工作态内容：渲染在 sonner 默认卡片内（toast(jsx) 而非 toast.custom，后者无卡片样式）。
function WorkingBody({ m }: { m: WorkingModel }) {
  return (
    <div className="flex w-full flex-col gap-1.5" data-testid="transfer-toast">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.fileName}</span>
        <button
          type="button"
          onClick={m.onCancel}
          data-testid="transfer-cancel"
          className="-mr-1 shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {i18n.t('files.transfer.cancel')}
        </button>
      </div>
      <Progress value={m.pct} />
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{phaseLabel(m.phase)}</span>
        <span className="shrink-0 tabular-nums">
          {m.rate ?? ''}
          {m.total > 0 ? ` · ${formatBytes(m.sent)} / ${formatBytes(m.total)}` : ''}
        </span>
      </div>
    </div>
  );
}

export interface TransferToast {
  update: (p: TransferProgress) => void;
  success: (message: string) => void;
  fail: (message: string) => void;
}

// 启动一个传输进度 Toast，复用 app 统一的 sonner 卡片样式：
// - 工作态：中性卡片 + 自定义进度内容；duration:Infinity + dismissible:false + closeButton:false
//   （不自动消失、不可手动关闭，唯一中止是取消按钮）。
// - 完成：success 卡片（richColors 绿）短暂停留后自动消失。
// - 失败/取消：error 卡片（richColors 红），保留且可手动关闭。
export function startTransferToast(fileName: string, onCancel: () => void): TransferToast {
  const id = `transfer-${fileName}-${performance.now()}`;
  const model: WorkingModel = { fileName, phase: 'upload', pct: 0, sent: 0, total: 0, onCancel };
  let lastRender = 0;

  const renderWorking = () => {
    toast(<WorkingBody m={{ ...model }} />, {
      id,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
      closeButton: false,
    });
  };
  renderWorking();

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
      renderWorking();
    },
    success(message) {
      toast.success(<span data-testid="transfer-toast">{message}</span>, {
        id,
        duration: 4000,
        dismissible: true,
        closeButton: true,
      });
    },
    fail(message) {
      toast.error(<span data-testid="transfer-toast">{message}</span>, {
        id,
        duration: Number.POSITIVE_INFINITY,
        dismissible: true,
        closeButton: true,
      });
    },
  };
}
