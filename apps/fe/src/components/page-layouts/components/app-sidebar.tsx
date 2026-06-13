import { Bot, FolderClosed, Monitor, PanelsTopLeft } from 'lucide-react';
import type * as React from 'react';
import { useTranslation } from 'react-i18next';

import { AgentTab } from '@/components/agent-panel/agent-tab';
import { FilesTab } from '@/components/agent-panel/files-tab';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useUIStore } from '@/stores/ui';
import { NavMain } from './nav-main';
import { SideBarDeviceList } from './sidebar-device-list';
import { SidebarTitle } from './sidebar-title';

const navMainItems = [
  {
    title: 'nav.manageDevices',
    url: '/devices',
    icon: Monitor,
  },
];

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();
  const sidebarTab = useUIStore((state) => state.sidebarTab);
  const setSidebarTab = useUIStore((state) => state.setSidebarTab);

  return (
    <Sidebar variant="inset" {...props}>
      <div className="h-[var(--tmex-safe-area-top)]" />
      <SidebarHeader className="gap-2 py-3">
        <SidebarTitle />
        <Tabs
          value={sidebarTab}
          onValueChange={(value) => setSidebarTab(value as typeof sidebarTab)}
        >
          <TabsList className="w-full">
            <TabsTrigger value="panes" data-testid="sidebar-tab-panes">
              <PanelsTopLeft />
              {t('sidebar.tab.panes')}
            </TabsTrigger>
            <TabsTrigger value="agent" data-testid="sidebar-tab-agent">
              <Bot />
              {t('sidebar.tab.agent')}
            </TabsTrigger>
            <TabsTrigger value="files" data-testid="sidebar-tab-files">
              <FolderClosed />
              {t('sidebar.tab.files')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </SidebarHeader>
      <SidebarContent className="flex min-h-0 flex-col overflow-hidden">
        {sidebarTab === 'panes' && <SideBarDeviceList />}
        {sidebarTab === 'agent' && <AgentTab />}
        {sidebarTab === 'files' && <FilesTab />}
      </SidebarContent>
      {sidebarTab === 'panes' && (
        <SidebarFooter>
          <NavMain items={navMainItems} />
          <div className="h-[var(--tmex-safe-area-bottom)]" />
        </SidebarFooter>
      )}
    </Sidebar>
  );
}
