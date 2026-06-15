import { toast } from 'sonner';

import { Progress } from '@/components/ui/progress';
import i18n from '@/i18n';
import type { LegProgress } from './api';

export type TransferDirection = 'upload' | 'download';

interface ToastModel {
  fileName: string;
  direction: TransferDirection;
  legs: [LegProgress, LegProgress];
  onCancel: () => void;
}

function legLabel(direction: TransferDirection, leg: 1 | 2): string {
  if (direction === 'upload') {
    return leg === 1
      ? i18n.t('files.transfer.legUserToTmex')
      : i18n.t('files.transfer.legTmexToServer');
  }
  return leg === 1
    ? i18n.t('files.transfer.legServerToTmex')
    : i18n.t('files.transfer.legTmexToUser');
}

function LegRow({ label, leg }: { label: string; leg: LegProgress }) {
  const meta = [leg.rate, leg.detail].filter(Boolean).join(' · ');
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className="shrink-0 tabular-nums">{meta}</span>
      </div>
      <Progress value={leg.pct} />
    </div>
  );
}

// 工作态内容：渲染在 sonner 默认卡片内，同时显示两段进度（leg1 / leg2）。
function WorkingBody({ m }: { m: ToastModel }) {
  return (
    <div className="flex w-full flex-col gap-2" data-testid="transfer-toast">
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
      <LegRow label={legLabel(m.direction, 1)} leg={m.legs[0]} />
      <LegRow label={legLabel(m.direction, 2)} leg={m.legs[1]} />
    </div>
  );
}

export interface TransferToast {
  leg: (n: 1 | 2, p: LegProgress) => void;
  success: (message: string) => void;
  fail: (message: string) => void;
}

// 启动传输进度 Toast，复用 app 统一的 sonner 卡片样式，并同时展示两段进度条。
// 工作态：duration:Infinity + dismissible:false + closeButton:false（不自动消失/不可手动关闭，
// 仅取消按钮可终止）。完成 success 卡片（短暂后消失）；失败/取消 error 卡片（保留可关闭）。
export function startTransferToast(
  fileName: string,
  direction: TransferDirection,
  onCancel: () => void
): TransferToast {
  const id = `transfer-${fileName}-${performance.now()}`;
  const model: ToastModel = {
    fileName,
    direction,
    legs: [{ pct: 0 }, { pct: 0 }],
    onCancel,
  };
  let lastRender = 0;

  const renderWorking = () => {
    const snapshot: ToastModel = {
      ...model,
      legs: [{ ...model.legs[0] }, { ...model.legs[1] }],
    };
    toast(<WorkingBody m={snapshot} />, {
      id,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
      closeButton: false,
    });
  };
  renderWorking();

  return {
    leg(n, p) {
      model.legs[n - 1] = p;
      const now = performance.now();
      // 100% 立即渲染（保证完成段显示满格），否则节流
      if (p.pct < 100 && now - lastRender < 100) return;
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
