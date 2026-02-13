import { Link } from "react-router";
import { Settings } from "lucide-react";
import { useSiteStore } from "../../../stores/site";

export function SidebarTitle() {
  const siteName = useSiteStore((state) => state.settings?.siteName ?? 'tmex');

  return (
    <div className="flex items-center gap-2 px-2">
      <Link to="/" className="flex flex-1 items-center gap-3 overflow-hidden">
        <div className="h-8 w-8 shrink-0 overflow-hidden rounded-lg border-2 border-black">
          <img
            src="/logo.png"
            alt={siteName}
            className="h-full w-full object-cover"
          />
        </div>
        <span className="truncate text-sm font-semibold tracking-tight">
          {siteName}
        </span>
      </Link>
      <Link
        to="/settings"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        aria-label="Settings"
      >
        <Settings className="h-4 w-4" />
      </Link>
    </div>
  );
}
