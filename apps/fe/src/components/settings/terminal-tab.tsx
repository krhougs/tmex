import { TerminalPreview } from '@/components/terminal/TerminalPreview';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FONT_MANIFEST, getFontEntry } from '@/lib/fonts';
import { useUIStore } from '@/stores/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 28;
const LINE_HEIGHT_MIN = 1;
const LINE_HEIGHT_MAX = 2;

export function TerminalSettingsTab() {
  const { t } = useTranslation();

  const terminalFontSize = useUIStore((state) => state.terminalFontSize);
  const setTerminalFontSize = useUIStore((state) => state.setTerminalFontSize);
  const terminalLineHeight = useUIStore((state) => state.terminalLineHeight);
  const setTerminalLineHeight = useUIStore((state) => state.setTerminalLineHeight);
  const terminalFontId = useUIStore((state) => state.terminalFontId);
  const setTerminalFontId = useUIStore((state) => state.setTerminalFontId);

  // 本地字符串态：让输入框完整显示用户键入内容，仅当落在合法区间时才提交到 store。
  const [fontSizeInput, setFontSizeInput] = useState(String(terminalFontSize));
  const [lineHeightInput, setLineHeightInput] = useState(String(terminalLineHeight));

  useEffect(() => {
    setFontSizeInput(String(terminalFontSize));
  }, [terminalFontSize]);
  useEffect(() => {
    setLineHeightInput(String(terminalLineHeight));
  }, [terminalLineHeight]);

  return (
    <Card className="border-0 ring-0">
      <CardHeader>
        <CardTitle>{t('settings.terminal.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-muted-foreground text-sm">{t('settings.terminal.description')}</p>

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
          <span className="block text-sm font-medium">{t('settings.terminal.preview')}</span>
          <TerminalPreview />
        </div>
      </CardContent>
    </Card>
  );
}
