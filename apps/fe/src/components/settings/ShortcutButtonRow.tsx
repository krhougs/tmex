import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { escapeForDisplay, labelToSymbols } from '@/utils/terminalKeySequence';
import type { TerminalShortcutAction, TerminalShortcutItem } from '@tmex/shared';
import { ArrowDownToLine, ClipboardPaste, Keyboard, type LucideIcon, Radar } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// action 类按钮固定用图标展示（完整文字太长），title/aria 给完整文案。
const ACTION_ICON: Record<TerminalShortcutAction, LucideIcon> = {
  paste: ClipboardPaste,
  toggleKeyboard: Keyboard,
  newAgentSession: Radar,
  scrollToBottom: ArrowDownToLine,
};

interface ShortcutButtonRowProps {
  items: TerminalShortcutItem[];
  useIcons: boolean;
  onActivate?: (item: TerminalShortcutItem) => void;
  disabled?: boolean;
  /** 终端栏需要阻止焦点转移（避免 iOS 收起键盘）；预览不需要 */
  preventFocusSteal?: boolean;
  className?: string;
  rowTestId?: string;
  /** 按钮 data-testid 前缀（终端栏与预览区分，默认 'editor-shortcut'） */
  idPrefix?: string;
}

/**
 * 一排终端快捷键按钮（终端栏与设置页预览复用）。
 * send 类：按 useIcons 切换 文字 / 苹果符号，等宽字体；action 类：固定 lucide 图标。
 */
export function ShortcutButtonRow({
  items,
  useIcons,
  onActivate,
  disabled = false,
  preventFocusSteal = false,
  className,
  rowTestId = 'editor-shortcuts-row',
  idPrefix = 'editor-shortcut',
}: ShortcutButtonRowProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        'shortcut-row flex items-center gap-1.5 py-2 overflow-x-auto scrollbar-thin',
        className
      )}
      data-testid={rowTestId}
    >
      {items.map((item) => {
        const isAction = item.type === 'action';
        const ActionIcon = isAction && item.action ? ACTION_ICON[item.action] : null;
        const actionLabel =
          isAction && item.action ? t(`settings.terminal.shortcuts.action.${item.action}`) : '';
        // send 项 label 兜底：为空时回退到可读的 payload 转义串，保证有可见文字与可访问名
        const sendLabel = item.label || escapeForDisplay(item.payload ?? '');
        const sendText = useIcons ? labelToSymbols(sendLabel) : sendLabel;
        // action 项优先使用用户自定义 label（与编辑器可编辑一致），回退到内置动作名
        const ariaLabel = isAction ? item.label.trim() || actionLabel : sendLabel;

        return (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            size="sm"
            className="terminal-shortcut-btn h-8 min-w-9 px-2.5 rounded-full font-mono text-[13px] font-medium tracking-wide shrink-0 [@media(any-pointer:coarse)]:h-9 [@media(any-pointer:coarse)]:min-w-10 [@media(any-pointer:coarse)]:px-3"
            title={ariaLabel}
            aria-label={ariaLabel}
            data-testid={`${idPrefix}-${item.id}`}
            onMouseDown={preventFocusSteal ? (e) => e.preventDefault() : undefined}
            onClick={onActivate ? () => onActivate(item) : undefined}
            disabled={disabled}
          >
            {ActionIcon ? <ActionIcon className="h-4 w-4" /> : <span>{sendText}</span>}
          </Button>
        );
      })}
    </div>
  );
}
