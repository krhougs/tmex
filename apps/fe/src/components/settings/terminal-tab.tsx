import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from 'react-i18next';
import { TerminalSettingsPanel } from './terminal-settings-panel';

export function TerminalSettingsTab() {
  const { t } = useTranslation();

  return (
    <Card className="border-0 ring-0">
      <CardHeader>
        <CardTitle>{t('settings.terminal.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <TerminalSettingsPanel />
      </CardContent>
    </Card>
  );
}
