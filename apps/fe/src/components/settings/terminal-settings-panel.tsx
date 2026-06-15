import { TerminalPreview } from '@/components/terminal/TerminalPreview';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FONT_MANIFEST, getFontEntry } from '@/lib/fonts';
import { cn } from '@/lib/utils';
import { type KeyboardBehaviorMode, useUIStore } from '@/stores/ui';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TerminalShortcutsEditor } from './TerminalShortcutsEditor';

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 28;
const LINE_HEIGHT_MIN = 1;
const LINE_HEIGHT_MAX = 2;

// 手机键盘弹出时的页面避让模式（issue #27），并入终端设置。
const KEYBOARD_MODE_ITEMS = [
  {
    value: 'lift',
    labelKey: 'terminal.keyboardBehavior.modeLift',
    descKey: 'terminal.keyboardBehavior.modeLiftDesc',
  },
  {
    value: 'resize',
    labelKey: 'terminal.keyboardBehavior.modeResize',
    descKey: 'terminal.keyboardBehavior.modeResizeDesc',
  },
  {
    value: 'follow',
    labelKey: 'terminal.keyboardBehavior.modeFollow',
    descKey: 'terminal.keyboardBehavior.modeFollowDesc',
  },
] as const satisfies ReadonlyArray<{
  value: KeyboardBehaviorMode;
  labelKey: string;
  descKey: string;
}>;

/**
 * 终端设置面板（设置页 Tab 与终端页右上角 Sheet 复用同一组件）。
 * 字号/行高/字体/键盘行为即改即生效，仅保存在当前浏览器。
 */
export function TerminalSettingsPanel({
  showPreview = true,
  showShortcuts = true,
}: {
  showPreview?: boolean;
  /** 是否在面板内联快捷键编辑器（Sheet=true 单弹层；设置页 Tab=false 由独立卡片承载） */
  showShortcuts?: boolean;
}) {
  const { t } = useTranslation();

  const terminalFontSize = useUIStore((state) => state.terminalFontSize);
  const setTerminalFontSize = useUIStore((state) => state.setTerminalFontSize);
  const terminalLineHeight = useUIStore((state) => state.terminalLineHeight);
  const setTerminalLineHeight = useUIStore((state) => state.setTerminalLineHeight);
  const terminalFontId = useUIStore((state) => state.terminalFontId);
  const setTerminalFontId = useUIStore((state) => state.setTerminalFontId);
  const keyboardMode = useUIStore((state) => state.keyboardBehaviorMode);
  const setKeyboardMode = useUIStore((state) => state.setKeyboardBehaviorMode);

  // 本地字符串态：让数字输入框完整显示键入内容，仅当落在合法区间时才提交到 store。
  const [fontSizeInput, setFontSizeInput] = useState(String(terminalFontSize));
  const [lineHeightInput, setLineHeightInput] = useState(String(terminalLineHeight));

  useEffect(() => {
    setFontSizeInput(String(terminalFontSize));
  }, [terminalFontSize]);
  useEffect(() => {
    setLineHeightInput(String(terminalLineHeight));
  }, [terminalLineHeight]);

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">{t('settings.terminal.description')}</p>

      {showPreview && (
        <div className="space-y-2">
          <span className="block text-sm font-medium">{t('settings.terminal.preview')}</span>
          <TerminalPreview />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="terminal-font-size">
            {t('settings.terminal.fontSize')}
          </label>
          <Input
            id="terminal-font-size"
            data-testid="terminal-font-size"
            type="number"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={fontSizeInput}
            onChange={(event) => {
              setFontSizeInput(event.target.value);
              const next = Number(event.target.value);
              if (Number.isFinite(next) && next >= FONT_SIZE_MIN && next <= FONT_SIZE_MAX) {
                setTerminalFontSize(next);
              }
            }}
            className="min-h-10"
          />
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="terminal-line-height">
            {t('settings.terminal.lineHeight')}
          </label>
          <Input
            id="terminal-line-height"
            data-testid="terminal-line-height"
            type="number"
            min={LINE_HEIGHT_MIN}
            max={LINE_HEIGHT_MAX}
            step={0.1}
            value={lineHeightInput}
            onChange={(event) => {
              setLineHeightInput(event.target.value);
              const next = Number(event.target.value);
              if (Number.isFinite(next) && next >= LINE_HEIGHT_MIN && next <= LINE_HEIGHT_MAX) {
                setTerminalLineHeight(next);
              }
            }}
            className="min-h-10"
          />
        </div>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="terminal-font-family">
          {t('settings.terminal.fontFamily')}
        </label>
        <Select
          value={terminalFontId}
          onValueChange={(value) => {
            if (value) {
              setTerminalFontId(value);
            }
          }}
        >
          <SelectTrigger
            id="terminal-font-family"
            data-testid="terminal-font-family"
            className="min-h-10 w-full"
          >
            <SelectValue>{getFontEntry(terminalFontId).displayName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {FONT_MANIFEST.map((font) => (
              <SelectItem key={font.id} value={font.id}>
                {font.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <span className="block text-sm font-medium">{t('terminal.keyboardBehavior.title')}</span>
        <p className="text-muted-foreground text-xs">
          {t('terminal.keyboardBehavior.description')}
        </p>
        <div className="flex flex-col gap-2">
          {KEYBOARD_MODE_ITEMS.map((item) => {
            const selected = keyboardMode === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => setKeyboardMode(item.value)}
                aria-pressed={selected}
                data-testid={`keyboard-behavior-option-${item.value}`}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                  selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                    selected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-muted-foreground/40'
                  )}
                >
                  {selected && <Check className="h-3.5 w-3.5" />}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{t(item.labelKey)}</span>
                  <span className="text-muted-foreground text-xs leading-snug">
                    {t(item.descKey)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-muted-foreground text-xs">{t('settings.terminal.savedInBrowser')}</p>

      {showShortcuts && (
        <>
          <div className="h-px bg-border" />

          <div className="space-y-2">
            <span className="block font-medium text-sm">
              {t('settings.terminal.shortcuts.title')}
            </span>
            <p className="text-muted-foreground text-xs">
              {t('settings.terminal.shortcuts.savedOnServer')}
            </p>
            <TerminalShortcutsEditor />
          </div>
        </>
      )}
    </div>
  );
}
