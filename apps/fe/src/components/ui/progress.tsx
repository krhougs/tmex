import { cn } from '@/lib/utils';

// 极简进度条：0-100 的 value 控制填充宽度（纯视觉，进度文本由调用方展示）。
function Progress({ value = 0, className }: { value?: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className={cn('bg-secondary relative h-1.5 w-full overflow-hidden rounded-full', className)}
    >
      <div
        className="bg-primary h-full rounded-full transition-[width] duration-150"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export { Progress };
