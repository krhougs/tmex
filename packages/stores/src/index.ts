// 应用状态层：默认 runtime 的原名导出（单实例宿主零改动）+ 工厂与类型

export { createAppRuntime, type AppRuntime } from './app-runtime';
export { defaultRuntime } from './default-runtime';
export {
  hostAppPath,
  setDefaultNotificationSink,
  type AppRuntimeOptions,
  type HostServices,
  type HostFileDragDropEvent,
  type HostPathReference,
  type RuntimeCore,
  type SaveFileInput,
  type TerminalFileLinkRoot,
  type TerminalFileLinksProvider,
  type TerminalFileUploadOptions,
  type RuntimeFeatures,
} from './runtime';

export { createUIStore, type KeyboardBehaviorMode, type SidebarSection, type UIStore } from './ui';
export { createSiteStore, type SiteStore } from './site';
export { createTmuxStore, type DeviceInitialErrorInput, type TmuxStore } from './tmux';
export {
  createAgentStore,
  type AgentStore,
  type CreateSessionOptions,
  type DraftSession,
  type PendingConfirmationUi,
} from './agent';
export { createFileTreeStore, fileNodeKey, type FileTreeStore } from './file-tree';

export * from './agent-thread';
export { getSiteNameFallback, getSiteUrlFallback } from './site-fallback';
export { decodePaneIdFromUrlParam, encodePaneIdForUrl } from './tmux-url';
export { decodeFileRef, encodeFileRef, fileRoute, type FileRef } from './file-url';
export * from './terminal-meta';
export { navigateToAppUrl } from './app-navigation';
export {
  bridgeCloseMobileSidebar,
  bridgeIsMobile,
  bridgeNavigate,
  bridgeOpenMobileSidebar,
  setNavigateBridge,
  setSidebarBridge,
} from './flow-bridges';
export { usePaneAgentState, type PaneAgentState } from './use-pane-agent-state';

// ---- 默认 runtime 的原名 store 导出（拆包前公共 API，保持零改动消费） ----
import { defaultRuntime } from './default-runtime';

export const useUIStore = defaultRuntime.stores.ui;
export const useSiteStore = defaultRuntime.stores.site;
export const useTmuxStore = defaultRuntime.stores.tmux;
export const useAgentStore = defaultRuntime.stores.agent;
export const useFileTreeStore = defaultRuntime.stores.fileTree;

export type { AgentSessionDto, AgentSessionStatus } from '@tmex/shared';
