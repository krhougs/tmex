import { useTranslation } from 'react-i18next';

import { FolderIcon } from 'lucide-react';

export function FilesTab() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="files-tab"
      className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 px-4 text-center"
    >
      <FolderIcon className="size-8 opacity-50" />
      <span className="text-sm">{t('agent.files.comingSoon')}</span>
    </div>
  );
}
