import { cn } from '@/lib/utils';

export function UserMessage({ text, className }: { text: string; className?: string }) {
  return (
    <div
      data-testid="agent-user-message"
      className={cn(
        'bg-primary text-primary-foreground max-w-[85%] self-end rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words',
        className
      )}
    >
      {text}
    </div>
  );
}
