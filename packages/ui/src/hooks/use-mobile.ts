import * as React from "react"

// 与 Tailwind v4 的 md 断点（48rem）保持同一媒体查询口径；
// 只信 matchMedia 的 matches，规避 viewport 收敛期间 innerWidth 的陈旧读数。
export const DEFAULT_DESKTOP_MEDIA_QUERY = "(min-width: 48rem)"

export function useIsMobile(desktopMediaQuery = DEFAULT_DESKTOP_MEDIA_QUERY) {
  const [isMobile, setIsMobile] = React.useState(() =>
    typeof window === "undefined" ? false : !window.matchMedia(desktopMediaQuery).matches
  )

  React.useEffect(() => {
    const mql = window.matchMedia(desktopMediaQuery)
    const onChange = (event: MediaQueryListEvent) => {
      setIsMobile(!event.matches)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(!mql.matches)
    return () => mql.removeEventListener("change", onChange)
  }, [desktopMediaQuery])

  return isMobile
}
