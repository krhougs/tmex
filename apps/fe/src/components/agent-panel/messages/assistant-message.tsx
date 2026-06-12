import { StreamingMarkdown } from '@/components/markdown/streaming-markdown';
import { cn } from '@/lib/utils';

export function AssistantMessage({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <div
      data-testid="agent-assistant-message"
      className={cn('min-w-0 max-w-full self-start', className)}
    >
      <StreamingMarkdown text={text} streaming={streaming} />
    </div>
  );
}
