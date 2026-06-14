import { Bot, FolderClosed, Monitor, PanelsTopLeft } from 'lucide-react';
import type * as React from 'react';
import { useTranslation } from 'react-i18next';

import { AgentTab } from '@/components/agent-panel/agent-tab';
import { FilesTab } from '@/components/files-panel/files-tab';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useUIStore } from '@/stores/ui';
import { NavMain } from './nav-main';
import { SideBarDeviceList } from './sidebar-device-list';
import { SidebarTitle } from './sidebar-title';

// 灰色轨道(bg-muted)上嵌一个更亮的圆角药丸：亮色用 bg-background(白)，暗色用更亮的半透明覆盖，去边框。
// rounded-lg 与外层 rounded-xl 轨道同心收敛。
export const tabTriggerClassName =
  "rounded-lg data-active:bg-background data-active:text-foreground data-active:border-transparent group-data-[variant=default]/tabs-list:data-active:shadow-none dark:data-active:bg-input/60 dark:data-active:border-transparent text-[13px] transition-colors duration-200 [&_svg:not([class*='size-'])]:size-[15px]";

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
      <SidebarHeader className="gap-5 pt-3 pb-0">
        <SidebarTitle />
        <Tabs
          className="mb-2.5"
          value={sidebarTab}
          onValueChange={(value) => setSidebarTab(value as typeof sidebarTab)}
        >
          <TabsList className="w-full p-1 rounded-xl border border-border/60 group-data-horizontal/tabs:h-11">
            <TabsTrigger
              value="panes"
              data-testid="sidebar-tab-panes"
              className={tabTriggerClassName}
            >
              <PanelsTopLeft />
              {t('sidebar.tab.panes')}
            </TabsTrigger>
            <TabsTrigger
              value="agent"
              data-testid="sidebar-tab-agent"
              className={tabTriggerClassName}
            >
              <Bot />
              {t('sidebar.tab.agent')}
            </TabsTrigger>
            <TabsTrigger
              value="files"
              data-testid="sidebar-tab-files"
              className={tabTriggerClassName}
            >
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
