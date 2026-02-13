import { useEffect } from "react";
import { Moon, Settings, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSiteStore } from "../../../stores/site";
import { useUIStore } from "../../../stores/ui";
import { NavLink } from "./nav-link";

export function SidebarTitle() {
  const { t } = useTranslation();
  const siteName = useSiteStore((state) => state.settings?.siteName);
  
  // Fetch settings on mount if not loaded
  const fetchSettings = useSiteStore((state) => state.fetchSettings);
  
  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const displayName = siteName ?? 'tmex';

  // Theme toggle
  const theme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const isDark = theme === 'dark';
  const toggleTheme = () => {
    const nextTheme = isDark ? 'light' : 'dark';
    setTheme(nextTheme);
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
  };

  return (
    <div className="flex items-center gap-2 px-2">
      <NavLink to="/" className="flex flex-1 items-center gap-3 overflow-hidden">
        <div className="h-8 w-8 shrink-0 overflow-hidden rounded-lg border-2 border-black">
          <img
            src="/logo.png"
            alt={displayName}
            className="h-full w-full object-cover"
          />
        </div>
        <span className="truncate text-sm font-semibold tracking-tight">
          {displayName}
        </span>
      </NavLink>
      <button
        type="button"
        onClick={toggleTheme}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        aria-label={isDark ? t('settings.themeLight') : t('settings.themeDark')}
        title={isDark ? t('settings.themeLight') : t('settings.themeDark')}
      >
        {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
      <NavLink
        to="/settings"
        className="inline-flex h-8 w-8 mr-[-8px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        aria-label={t('sidebar.settings')}
        title={t('sidebar.settings')}
      >
        <Settings className="h-4 w-4" />
      </NavLink>
    </div>
  );
}
