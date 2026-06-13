import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { UiToolCall } from '@/stores/agent-thread';
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  GlobeIcon,
  KeyboardIcon,
  Loader2Icon,
  MonitorIcon,
  SearchIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface ToolCardConfirmation {
  id: string;
  toolCallId: string;
}

interface ToolCallCardProps {
  call: UiToolCall;
  confirmationId?: string;
  onDecide?: (confirmationId: string, approved: boolean) => void;
  className?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function callErrorText(call: UiToolCall): string | null {
  if (isRecord(call.output) && typeof call.output.error === 'string') {
    return call.output.error;
  }
  if (call.isError) {
    return asText(call.output);
  }
  return null;
}

function toolIcon(toolName: string): ReactNode {
  switch (toolName) {
    case 'send_input':
      return <KeyboardIcon className="size-3.5" />;
    case 'read_screen':
      return <MonitorIcon className="size-3.5" />;
    case 'web_search':
      return <SearchIcon className="size-3.5" />;
    case 'fetch_url':
      return <GlobeIcon className="size-3.5" />;
    default:
      return <WrenchIcon className="size-3.5" />;
  }
}

function CollapsedText({ label, text }: { label: string; text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1 text-xs">
        <ChevronRightIcon className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
        <span>{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="bg-muted mt-1 max-h-64 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap break-all">
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

function parseWebSearchResults(output: unknown): WebSearchResultItem[] | null {
  if (typeof output !== 'string') return null;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter(isRecord)
      .map((item) => ({
        title: typeof item.title === 'string' ? item.title : '',
        url: typeof item.url === 'string' ? item.url : '',
        snippet: typeof item.snippet === 'string' ? item.snippet : '',
      }))
      .filter((item) => item.url);
  } catch {
    // 输出可能被字节上限截断导致 JSON 不完整
    return null;
  }
}

function SendInputBody({ call }: { call: UiToolCall }) {
  const { t } = useTranslation();
  const input = isRecord(call.input) ? call.input : {};
  const text = typeof input.text === 'string' ? input.text : '';
  const keys = Array.isArray(input.keys) ? input.keys.filter((k) => typeof k === 'string') : [];
  const output = isRecord(call.output) ? call.output : {};
  const screenTail = typeof output.screenTail === 'string' ? output.screenTail : '';

  return (
    <div className="flex flex-col gap-1.5">
      {text && (
        <pre className="bg-muted max-h-40 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap break-all">
          {text}
        </pre>
      )}
      {keys.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {keys.map((key, index) => (
            <Badge key={`${index}-${key}`} variant="outline" className="font-mono">
              {key as string}
            </Badge>
          ))}
        </div>
      )}
      {screenTail && <CollapsedText label={t('agent.tool.result')} text={screenTail} />}
    </div>
  );
}

function ReadScreenBody({ call }: { call: UiToolCall }) {
  const { t } = useTranslation();
  const output = isRecord(call.output) ? call.output : {};
  const screen = typeof output.screen === 'string' ? output.screen : '';
  if (!screen) return null;
  return <CollapsedText label={t('agent.tool.screen')} text={screen} />;
}

function WebSearchBody({ call }: { call: UiToolCall }) {
  const { t } = useTranslation();
  const input = isRecord(call.input) ? call.input : {};
  const query = typeof input.query === 'string' ? input.query : '';
  const results =
    call.resolved && !call.isError && !call.denied ? parseWebSearchResults(call.output) : null;

  return (
    <div className="flex flex-col gap-1.5">
      {query && <p className="text-muted-foreground text-xs break-words">“{query}”</p>}
      {results && results.length > 0 && (
        <ul className="flex flex-col gap-1">
          {results.map((item) => (
            <li key={item.url} className="min-w-0 text-xs">
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary block truncate underline underline-offset-2"
                title={item.title || item.url}
              >
                {item.title || item.url}
              </a>
              {item.snippet && (
                <p className="text-muted-foreground line-clamp-2 break-words">{item.snippet}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {call.resolved &&
        !call.isError &&
        !call.denied &&
        !results &&
        typeof call.output === 'string' && (
          <CollapsedText label={t('agent.tool.result')} text={call.output} />
        )}
    </div>
  );
}

function FetchUrlBody({ call }: { call: UiToolCall }) {
  const { t } = useTranslation();
  const input = isRecord(call.input) ? call.input : {};
  const url = typeof input.url === 'string' ? input.url : '';
  const body = typeof call.output === 'string' ? call.output : '';

  return (
    <div className="flex flex-col gap-1.5">
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary block truncate text-xs underline underline-offset-2"
          title={url}
        >
          {url}
        </a>
      )}
      {call.resolved && !call.isError && !call.denied && body && (
        <CollapsedText label={t('agent.tool.result')} text={body} />
      )}
    </div>
  );
}

const BASE64_IMAGE_RE = /^[A-Za-z0-9+/]{256,}={0,2}$/;
const IMAGE_URL_RE = /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i;

function asImageSrc(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.startsWith('data:image/')) return value;
  if (IMAGE_URL_RE.test(value)) return value;
  // 裸 base64（如 OpenAI image_generation 的 { result }）默认按 png 处理
  if (BASE64_IMAGE_RE.test(value.replace(/\s/g, ''))) {
    return `data:image/png;base64,${value.replace(/\s/g, '')}`;
  }
  return null;
}

/** 通用：从 tool output 探测可内联渲染的图片（image_generation 的 result / image / images 等字段） */
function extractToolImages(call: UiToolCall): string[] {
  if (!call.resolved || call.isError || call.denied) return [];
  const images: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (images.length >= 8 || depth > 3) return;
    const src = asImageSrc(value);
    if (src) {
      images.push(src);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const key of ['result', 'image', 'images', 'url', 'b64_json', 'data']) {
        if (key in value) visit(value[key], depth + 1);
      }
    }
  };
  visit(call.output, 0);
  return [...new Set(images)];
}

function ToolImages({ images }: { images: string[] }) {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((src, index) => (
        <a
          // biome-ignore lint/suspicious/noArrayIndexKey: 顺序稳定的图片列表
          key={index}
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
        >
          <img
            src={src}
            alt="generated"
            className="max-h-64 max-w-full rounded-md border border-border object-contain"
            loading="lazy"
          />
        </a>
      ))}
    </div>
  );
}

function GenericBody({ call, hideOutput }: { call: UiToolCall; hideOutput?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      {call.input !== undefined && (
        <CollapsedText label={t('agent.tool.input')} text={asText(call.input)} />
      )}
      {!hideOutput &&
        call.resolved &&
        !call.isError &&
        !call.denied &&
        call.output !== undefined && (
          <CollapsedText label={t('agent.tool.result')} text={asText(call.output)} />
        )}
    </div>
  );
}

export function ToolCallCard({ call, confirmationId, onDecide, className }: ToolCallCardProps) {
  const { t } = useTranslation();
  const pendingApproval = Boolean(confirmationId) && !call.resolved;
  const denied = call.resolved && call.denied;
  const errorText = call.resolved && !denied ? callErrorText(call) : null;
  const running = !call.resolved && !pendingApproval;
  const deniedReason = denied && typeof call.output === 'string' ? call.output : '';

  const toolLabelKey = `agent.tool.${call.toolName}`;
  const toolLabel = ['send_input', 'read_screen', 'web_search', 'fetch_url'].includes(call.toolName)
    ? t(toolLabelKey)
    : call.toolName;

  const images = extractToolImages(call);

  return (
    <div
      data-testid={`agent-tool-card-${call.toolCallId}`}
      data-tool-name={call.toolName}
      data-tool-denied={denied || undefined}
      className={cn(
        'border-border bg-card flex max-w-full min-w-0 flex-col gap-1.5 self-start rounded-md border p-2',
        errorText !== null && 'border-destructive/50',
        denied && 'opacity-80',
        className
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {toolIcon(call.toolName)}
        <span className="min-w-0 truncate">{toolLabel}</span>
        {running && <Loader2Icon className="text-muted-foreground size-3 animate-spin" />}
        {call.resolved && !denied && errorText === null && (
          <CheckIcon className="size-3 text-emerald-500" />
        )}
        {errorText !== null && <CircleAlertIcon className="text-destructive size-3" />}
        {denied && (
          <span className="text-destructive flex items-center gap-0.5">
            <XIcon className="size-3" />
            {t('agent.tool.denied')}
          </span>
        )}
      </div>

      {call.toolName === 'send_input' && <SendInputBody call={call} />}
      {call.toolName === 'read_screen' && <ReadScreenBody call={call} />}
      {call.toolName === 'web_search' && <WebSearchBody call={call} />}
      {call.toolName === 'fetch_url' && <FetchUrlBody call={call} />}
      {!['send_input', 'read_screen', 'web_search', 'fetch_url'].includes(call.toolName) && (
        <GenericBody call={call} hideOutput={images.length > 0} />
      )}

      <ToolImages images={images} />

      {errorText !== null && (
        <p className="text-destructive text-xs break-words whitespace-pre-wrap">{errorText}</p>
      )}

      {deniedReason && (
        <p className="text-muted-foreground text-xs break-words whitespace-pre-wrap">
          {deniedReason}
        </p>
      )}

      {pendingApproval && confirmationId && (
        <div
          data-testid={`agent-tool-approval-${call.toolCallId}`}
          className="flex items-center gap-2 pt-1"
        >
          <span className="text-muted-foreground min-w-0 flex-1 text-xs">
            {t('agent.confirm.title')}
          </span>
          <Button
            data-testid="agent-confirm-approve"
            size="xs"
            variant="secondary"
            onClick={() => onDecide?.(confirmationId, true)}
          >
            <CheckIcon />
            {t('agent.confirm.approve')}
          </Button>
          <Button
            data-testid="agent-confirm-deny"
            size="xs"
            variant="destructive"
            onClick={() => onDecide?.(confirmationId, false)}
          >
            <XIcon />
            {t('agent.confirm.deny')}
          </Button>
        </div>
      )}
    </div>
  );
}
