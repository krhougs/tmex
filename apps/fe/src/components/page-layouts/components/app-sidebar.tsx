import * as React from "react";
import { Monitor } from "lucide-react";

import { NavMain } from "./nav-main";
import { SideBarDeviceList } from "./sidebar-device-list";
import { SidebarTitle } from "./sidebar-title";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarSeparator,
} from "@/components/ui/sidebar";

const navMainItems = [
  {
    title: "Devices",
    url: "/devices",
    icon: Monitor,
  },
];

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar variant="inset" {...props}>
      <div className="h-[var(--tmex-safe-area-top)]" />
      <SidebarHeader className="py-3">
        <SidebarTitle />
      </SidebarHeader>
      <SidebarContent className="flex flex-col">
        <NavMain items={navMainItems} />
        <SidebarSeparator />
        <SideBarDeviceList />
      </SidebarContent>
      <SidebarFooter>
        <div className="h-[var(--tmex-safe-area-bottom)]" />
      </SidebarFooter>
    </Sidebar>
  );
}
