import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from 'react-i18next';
import { TerminalShortcutsEditor } from './TerminalShortcutsEditor';
import { TerminalSettingsPanel } from './terminal-settings-panel';

export function TerminalSettingsTab() {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      {/* 卡片一：本机设置（字号/行高/字体/键盘行为）——仅存当前浏览器 */}
      <Card className="border-0 ring-0">
        <CardHeader>
          <CardTitle>{t('settings.terminal.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <TerminalSettingsPanel showShortcuts={false} />
        </CardContent>
      </Card>

      {/* 卡片二：自定义快捷键——保存在服务器、多端共享 */}
      <Card className="border-0 ring-0">
        <CardHeader>
          <CardTitle>{t('settings.terminal.shortcuts.title')}</CardTitle>
          <CardDescription>{t('settings.terminal.shortcuts.savedOnServer')}</CardDescription>
        </CardHeader>
        <CardContent>
          <TerminalShortcutsEditor />
        </CardContent>
      </Card>
    </div>
  );
}
