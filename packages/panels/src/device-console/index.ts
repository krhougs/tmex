// 设备终端控制台出口：主体 + 页头标题/操作区。
// 路由参数由宿主解析后显式传入；宿主需提供 RuntimeProvider（或使用默认 runtime）。

export { DeviceConsole, type DeviceConsoleProps } from './device-console';
export { DeviceConsoleActions, type DeviceConsoleActionsProps } from './page-actions';
export { DeviceConsolePageTitle, type DeviceConsolePageTitleProps } from './page-title';
export {
  resolveCanInteractWithPane,
  shouldShowTerminalReconnectOverlay,
} from './interaction';
