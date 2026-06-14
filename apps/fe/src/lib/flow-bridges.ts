// 模块级桥接：让 toast action 回调等「非 React context」代码也能 navigate / 强开手机端 sidebar。
// 由 <FlowBridges/>（挂在 RouterProvider + SidebarProvider 内）在挂载时注册具体实现。

type NavigateFn = (to: string, opts?: { replace?: boolean }) => void;

let navigateFn: NavigateFn | null = null;
export function setNavigateBridge(fn: NavigateFn | null): void {
  navigateFn = fn;
}
export function bridgeNavigate(to: string, opts?: { replace?: boolean }): void {
  navigateFn?.(to, opts);
}

interface SidebarBridgeApi {
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
}

let sidebarBridge: SidebarBridgeApi | null = null;
export function setSidebarBridge(api: SidebarBridgeApi | null): void {
  sidebarBridge = api;
}
export function bridgeIsMobile(): boolean {
  return sidebarBridge?.isMobile ?? false;
}
export function bridgeOpenMobileSidebar(): void {
  if (sidebarBridge?.isMobile) sidebarBridge.setOpenMobile(true);
}
