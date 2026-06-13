import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { UiThreadBlock } from '@/stores/agent-thread';
import { ArrowDownIcon } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AssistantMessage } from './messages/assistant-message';
import { ReasoningBlock } from './messages/reasoning-block';
import { ToolCallCard } from './messages/tool-call-card';
import { UserMessage } from './messages/user-message';

const PIN_THRESHOLD_PX = 48;

export interface ChatThreadProps {
  blocks: UiThreadBlock[];
  running: boolean;
  emptyText: string;
  confirmationByToolCallId: Map<string, string>;
  onDecide: (confirmationId: string, approved: boolean) => void;
  className?: string;
  style?: CSSProperties;
}

function RunningIndicator() {
  return (
    <div data-testid="agent-running-indicator" className="flex items-center gap-1 self-start px-1">
      <span className="bg-muted-foreground size-1.5 animate-pulse rounded-full" />
      <span className="bg-muted-foreground size-1.5 animate-pulse rounded-full [animation-delay:150ms]" />
      <span className="bg-muted-foreground size-1.5 animate-pulse rounded-full [animation-delay:300ms]" />
    </div>
  );
}

export function ChatThread({
  blocks,
  running,
  emptyText,
  confirmationByToolCallId,
  onDecide,
  className,
  style,
}: ChatThreadProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const scrollToBottom = (): void => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setShowJumpToBottom(false);
  };

  // 吸底：用户未上滚时新内容自动滚到底
  // biome-ignore lint/correctness/useExhaustiveDependencies: blocks/running 变化即触发吸底
  useEffect(() => {
    if (pinnedRef.current) {
      const el = containerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    } else {
      setShowJumpToBottom(true);
    }
  }, [blocks, running]);

  const handleScroll = (): void => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = distance < PIN_THRESHOLD_PX;
    pinnedRef.current = pinned;
    setShowJumpToBottom(!pinned);
  };

  if (blocks.length === 0 && !running) {
    return (
      <div
        data-testid="agent-chat-thread"
        className={cn('flex min-h-0 flex-1 items-center justify-center p-4', className)}
        style={style}
      >
        <p className="text-muted-foreground text-sm">{emptyText}</p>
      </div>
    );
  }

  return (
    <div className={cn('relative min-h-0 flex-1', className)} style={style}>
      <div
        ref={containerRef}
        data-testid="agent-chat-thread"
        className="h-full overflow-y-auto p-3"
        onScroll={handleScroll}
      >
        <div className="flex flex-col gap-3">
          {blocks.map((block) => {
            switch (block.kind) {
              case 'user':
                return <UserMessage key={block.key} text={block.text} />;
              case 'assistant-text':
                return (
                  <AssistantMessage key={block.key} text={block.text} streaming={block.streaming} />
                );
              case 'reasoning':
                return (
                  <ReasoningBlock key={block.key} text={block.text} streaming={block.streaming} />
                );
              case 'tool-call':
                return (
                  <ToolCallCard
                    key={block.key}
                    call={block.call}
                    confirmationId={confirmationByToolCallId.get(block.call.toolCallId)}
                    onDecide={onDecide}
                  />
                );
              default:
                return null;
            }
          })}
          {running && <RunningIndicator />}
        </div>
      </div>

      {showJumpToBottom && (
        <Button
          data-testid="agent-scroll-to-bottom"
          size="icon-sm"
          variant="secondary"
          className="absolute right-3 bottom-3 z-10 rounded-full shadow-md"
          onClick={scrollToBottom}
          aria-label={t('agent.panel.scrollToBottom')}
        >
          <ArrowDownIcon />
        </Button>
      )}
    </div>
  );
}
