import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { BrainIcon, ChevronRightIcon, Loader2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function ReasoningBlock({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();

  return (
    <Collapsible
      data-testid="agent-reasoning-block"
      className={cn('min-w-0 max-w-full self-start', className)}
    >
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1 text-xs">
        <ChevronRightIcon className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
        <BrainIcon className="size-3" />
        <span>{t('agent.reasoning.title')}</span>
        {streaming && <Loader2Icon className="size-3 animate-spin" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="text-muted-foreground border-border mt-1 border-l-2 pl-2 text-xs whitespace-pre-wrap break-words">
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
