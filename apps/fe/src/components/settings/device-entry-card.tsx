import { Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function DeviceEntryCard() {
  const { t } = useTranslation();
  return (
    <Card className="border-0 ring-0">
      <CardHeader>
        <CardTitle>{t('settings.deviceManagement.title')}</CardTitle>
        <CardDescription>{t('settings.deviceManagement.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Link
          to="/devices"
          data-testid="settings-device-management-link"
          className={buttonVariants({ variant: 'secondary' })}
        >
          <Monitor className="h-4 w-4" />
          {t('settings.deviceManagement.openButton')}
        </Link>
      </CardContent>
    </Card>
  );
}
