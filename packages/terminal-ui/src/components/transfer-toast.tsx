import type { LegProgress } from '@tmex/api-client';
import { Progress } from '@tmex/ui/progress';
import { toast } from '@tmex/ui/toast';
import i18next from 'i18next';

export type TransferDirection = 'upload' | 'download';

interface ToastModel {
  fileName: string;
  direction: TransferDirection;
  legs: [LegProgress, LegProgress];
}

function legLabel(direction: TransferDirection, leg: 1 | 2): string {
  if (direction === 'upload') {
    return leg === 1
      ? i18next.t('files.transfer.legUserToTmex')
      : i18next.t('files.transfer.legTmexToServer');
  }
  return leg === 1
    ? i18next.t('files.transfer.legServerToTmex')
    : i18next.t('files.transfer.legTmexToUser');
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

function WorkingBody({ model }: { model: ToastModel }) {
  return (
    <div className="flex w-full flex-col gap-2" data-testid="transfer-toast">
      <span className="min-w-0 truncate text-sm font-medium">{model.fileName}</span>
      <LegRow label={legLabel(model.direction, 1)} leg={model.legs[0]} />
      <LegRow label={legLabel(model.direction, 2)} leg={model.legs[1]} />
    </div>
  );
}

export interface TransferToast {
  leg: (leg: 1 | 2, progress: LegProgress) => void;
  success: (message: string) => void;
  fail: (message: string) => void;
  cancel: () => void;
}

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
  };
  let lastRender = 0;

  const renderWorking = () => {
    const snapshot: ToastModel = {
      ...model,
      legs: [{ ...model.legs[0] }, { ...model.legs[1] }],
    };
    toast(<WorkingBody model={snapshot} />, {
      id,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
      closeButton: false,
      action: { label: i18next.t('files.transfer.cancel'), onClick: onCancel },
    });
  };
  renderWorking();

  return {
    leg(leg, progress) {
      model.legs[leg - 1] = progress;
      const now = performance.now();
      if (progress.pct < 100 && now - lastRender < 100) return;
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
    cancel() {
      toast.dismiss(id);
    },
  };
}
