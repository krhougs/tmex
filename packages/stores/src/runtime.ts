// 应用运行时：把连接、REST 客户端、通知出口、宿主服务与各 store 按实例组装。
// 单实例宿主使用默认 runtime（index.ts 原名导出）；多实例宿主每个 gateway 建一份。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import {
  type BellPlayer,
  type NotificationSink,
  noopNotificationSink,
  playBellSound,
} from '@tmex/notifications';
import type { TranslateFn } from '@tmex/notifications';
import {
  type BorshWebSocketClient,
  type GatewayConnection,
  type GatewayPaneHistoryPage,
  type GatewayPaneScreenSnapshot,
  type GatewayRebaseReason,
  type GatewayTerminalData,
  type GatewayTransport,
  LazyWebSocketGatewayTransport,
  type SelectCallbacks,
  type SelectStateMachine,
  getBorshClient,
  getSelectStateMachine,
} from '@tmex/ws-client';
import {
  type PaneSink,
  beginPaneHistoryGate,
  cleanupDevicePaneState,
  dispatchPaneApplyHistory,
  dispatchPaneHistory,
  dispatchPaneHistoryPage,
  dispatchPaneOutput,
  dispatchPaneRebase,
  dispatchPaneReset,
  dispatchPaneScreenSnapshot,
  dispatchPaneTerminalData,
  hasPaneSink,
  onPaneSinkChange,
  registerPaneSink,
} from '@tmex/ws-client/pane-sink-registry';
import i18next from 'i18next';
import { bridgeCloseMobileSidebar, bridgeIsMobile, bridgeOpenMobileSidebar } from './flow-bridges';
import type { UIStore } from './ui';

export interface SaveFileInput {
  name: string;
  blob: Blob;
}

export interface ClipboardImage {
  blob: Blob | null;
  size: number;
  mimeType: string;
}

export interface HostServices {
  /** 应用内跳转（toast/通知点击等），语义等同 navigateToAppUrl */
  navigate(to: string, opts?: { replace?: boolean }): void;
  /**
   * 把包内构造的应用内路径（如 /devices/…、/file/…）映射为宿主路由形状；缺省恒等。
   * 必须是纯路径前缀变换（同一实现也会用于 matchPath pattern）。
   */
  appPath?(path: string): string;
  isMobile(): boolean;
  openMobileSidebar(): void;
  closeMobileSidebar(): void;
  /** 写入系统剪贴板；默认 Browser 实现含 Clipboard API + textarea/execCommand fallback */
  writeClipboardText(text: string): Promise<void>;
  /** 读取系统剪贴板文本 */
  readClipboardText(): Promise<string>;
  /** 读取系统剪贴板图片；宿主不支持时缺省为空。 */
  readClipboardImage?(): Promise<ClipboardImage | null>;
  /** 打开外部 URL（新标签页/系统浏览器等）；可异步 */
  openExternal(url: string): void | Promise<void>;
  /** 整页/宿主刷新 */
  reload(): void | Promise<void>;
  /** 将已传输完成的文件交给宿主保存（默认 object URL + a[download]） */
  saveFile(file: SaveFileInput): void | Promise<void>;
}

/** 终端文件链接授权根：识别用绝对路径 + 打开文件时回传的定位 id */
export interface TerminalFileLinkRoot {
  id: string;
  path: string;
}

/**
 * 终端文件链接面：路径识别用的授权根、存在性校验与打开动作。
 * 缺省实现走 gateway 文件 API 与 /file/:ref 路由（Terminal 组件内落地）；
 * 文件子系统另有实现的宿主可整体替换。
 */
export interface TerminalFileLinksProvider {
  /** 该设备可用的授权根；空数组＝该设备不启用文件链接识别 */
  listRoots(deviceId: string): Promise<TerminalFileLinkRoot[]>;
  /** 存在性校验；文件不存在时 reject */
  stat(rootId: string, path: string): Promise<unknown>;
  /** 上传文件到授权根；Native 宿主提供有界流式实现，Browser 缺省走 Gateway upload API。 */
  upload?(
    rootId: string,
    path: string,
    body: Blob,
    options?: {
      signal?: AbortSignal;
      onProgress?(progress: {
        loaded: number;
        total: number;
        pct: number;
        bytesPerSec: number;
      }): void;
    }
  ): Promise<void>;
  /** 打开文件（宿主自行导航） */
  openFile(rootId: string, path: string): void;
}

/** pane 输出路由面（默认绑模块级注册表，多实例绑各自 PaneSinkRegistry） */
export interface PaneSinkRouting {
  /** 终端组件挂载时注册 sink，返回注销函数（消费侧，与 dispatch 生产侧同一注册表） */
  registerPaneSink(deviceId: string, paneId: string, sink: PaneSink): () => void;
  dispatchPaneReset(deviceId: string, paneId: string, origin?: 'select' | 'history-refresh'): void;
  dispatchPaneApplyHistory(
    deviceId: string,
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): void;
  dispatchPaneOutput(deviceId: string, paneId: string, data: Uint8Array): void;
  dispatchPaneTerminalData(frame: GatewayTerminalData): void;
  dispatchPaneScreenSnapshot(snapshot: GatewayPaneScreenSnapshot): void;
  dispatchPaneHistoryPage(page: GatewayPaneHistoryPage): void;
  dispatchPaneRebase(deviceId: string, paneId: string, reason: GatewayRebaseReason): void;
  dispatchPaneHistory(
    deviceId: string,
    paneId: string,
    token: Uint8Array,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): boolean;
  beginPaneHistoryGate(deviceId: string, paneId: string, token: Uint8Array): void;
  hasPaneSink(deviceId: string, paneId: string): boolean;
  onPaneSinkChange(listener: () => void): () => void;
  cleanupDevicePaneState(deviceId: string): void;
}

export interface AppRuntimeOptions {
  /** 按连接组装的 WS 面；缺省绑各模块默认单例 */
  connection?: GatewayConnection;
  /** 外部进程/页面持有的共享 state transport；不会创建 physical WebSocket。 */
  transport?: GatewayTransport;
  apiClient?: ApiClient;
  notifications?: NotificationSink;
  bell?: BellPlayer;
  t?: TranslateFn;
  host?: HostServices;
  /** localStorage persist key 前缀；缺省空（与既有 key 完全一致） */
  storagePrefix?: string;
  /** 宿主共享的 UI 偏好 store（多 runtime 并存时传同一实例）；缺省按 storagePrefix 新建 */
  uiStore?: UIStore;
  /** UI 能力开关；缺省全开（单实例宿主零变化） */
  features?: {
    agentUi?: boolean;
    watchUi?: boolean;
    filesUi?: boolean;
    hostManagedNotifications?: boolean;
    hostManagedTheme?: boolean;
    hostManagedLocale?: boolean;
  };
  /** 终端文件链接面；缺省走 gateway 文件 API 与 /file/:ref 路由 */
  terminalFileLinks?: TerminalFileLinksProvider;
  /** create-window 超时毫秒数（测试注入短值用）；缺省 15000 */
  createWindowTimeoutMs?: number;
}

/** 已解析的 UI 能力开关 */
export interface RuntimeFeatures {
  agentUi: boolean;
  /** 终端监控（watch）UI：关断时不渲染 watch 入口与对话框，也不发起 watch 查询 */
  watchUi: boolean;
  /** 文件（files）UI：关断时不渲染文件面板与文件设置卡，也不发起 files 查询；markdown 预览不改写本地图片 src */
  filesUi: boolean;
  /** 宿主接管通知呈现：终端 notification 不再由包内弹 toast（bell 声与高亮不受影响） */
  hostManagedNotifications: boolean;
  /** 宿主接管主题呈现：site theme 不写 UI store、不改 document dark class、不写 localStorage 兜底 */
  hostManagedTheme: boolean;
  /** 宿主接管界面语言：site settings 的 language 不再驱动 i18next，宿主自行决定 */
  hostManagedLocale: boolean;
}

/** store 工厂消费的已解析服务面 */
export interface RuntimeCore {
  client: BorshWebSocketClient;
  transport: GatewayTransport;
  selectMachine(callbacks?: SelectCallbacks): SelectStateMachine;
  paneSinks: PaneSinkRouting;
  apiClient: ApiClient;
  notifications: NotificationSink;
  bell: BellPlayer;
  t: TranslateFn;
  host: HostServices;
  storagePrefix: string;
  features: RuntimeFeatures;
  terminalFileLinks?: TerminalFileLinksProvider;
}

/** Browser 默认：Clipboard API 失败后 textarea + execCommand('copy') fallback。 */
async function browserWriteClipboard(text: string): Promise<void> {
  if (!text) {
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through to execCommand fallback
    }
  }

  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    throw new Error('clipboard unavailable');
  }

  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', 'true');
  helper.style.position = 'fixed';
  helper.style.left = '-9999px';
  helper.style.top = '0';
  document.body.appendChild(helper);
  try {
    helper.select();
    if (!document.execCommand('copy')) {
      throw new Error('execCommand copy failed');
    }
  } finally {
    helper.remove();
  }
}

async function browserReadClipboard(): Promise<string> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
    throw new Error('clipboard unavailable');
  }
  return navigator.clipboard.readText();
}

async function browserReadClipboardImage(): Promise<ClipboardImage | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.read) return null;
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const mime = item.types.find((type) => type.startsWith('image/'));
    if (!mime) continue;
    const blob = await item.getType(mime);
    return { blob, size: blob.size, mimeType: mime };
  }
  return null;
}

function browserOpenExternal(url: string): void {
  if (typeof window === 'undefined') {
    throw new Error('openExternal unavailable');
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function browserReload(): void {
  if (typeof window === 'undefined') {
    throw new Error('reload unavailable');
  }
  window.location.reload();
}

/** Browser 默认：object URL + a[download]，成功与失败路径均清理 object URL / DOM helper。 */
async function browserSaveFile(file: SaveFileInput): Promise<void> {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw new Error('saveFile unavailable');
  }
  const objectUrl = URL.createObjectURL(file.blob);
  let anchor: HTMLAnchorElement | null = null;
  try {
    anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

const defaultHost: HostServices = {
  navigate(to, opts) {
    // 延迟 import 防环（app-navigation → flow-bridges 已在包内）
    void opts;
    navigateViaAppNavigation(to);
  },
  isMobile: bridgeIsMobile,
  openMobileSidebar: bridgeOpenMobileSidebar,
  closeMobileSidebar: bridgeCloseMobileSidebar,
  writeClipboardText: browserWriteClipboard,
  readClipboardText: browserReadClipboard,
  readClipboardImage: browserReadClipboardImage,
  openExternal: browserOpenExternal,
  reload: browserReload,
  saveFile: browserSaveFile,
};

// navigateToAppUrl 定义在 app-navigation.ts；直接 import 会与 runtime 无环（app-navigation 不依赖 runtime）
import { navigateToAppUrl as navigateViaAppNavigation } from './app-navigation';

// 默认通知出口：可变引用代理，宿主启动时注入实现（fe 注入统一 toast 适配器）。
// 代理形态保证「先建默认 runtime、后注入实现」的顺序也能生效。
const defaultSinkRef: { current: NotificationSink } = { current: noopNotificationSink };

export function setDefaultNotificationSink(sink: NotificationSink): void {
  defaultSinkRef.current = sink;
}

export const proxyDefaultNotificationSink: NotificationSink = {
  info: (title, options) => defaultSinkRef.current.info(title, options),
  success: (title, options) => defaultSinkRef.current.success(title, options),
  warning: (title, options) => defaultSinkRef.current.warning(title, options),
  error: (title, options) => defaultSinkRef.current.error(title, options),
};

const defaultBell: BellPlayer = { play: playBellSound };

const defaultPaneSinks: PaneSinkRouting = {
  registerPaneSink,
  hasPaneSink,
  onPaneSinkChange,
  dispatchPaneReset,
  dispatchPaneApplyHistory,
  dispatchPaneOutput,
  dispatchPaneTerminalData,
  dispatchPaneScreenSnapshot,
  dispatchPaneHistoryPage,
  dispatchPaneRebase,
  dispatchPaneHistory,
  beginPaneHistoryGate,
  cleanupDevicePaneState,
};

export function resolveRuntimeCore(options: AppRuntimeOptions = {}): RuntimeCore {
  const conn = options.connection;
  const transport =
    options.transport ??
    conn?.transport ??
    new LazyWebSocketGatewayTransport(() => conn?.client ?? getBorshClient());
  return {
    // 默认路径惰性求值：与拆包前「逐调用点 getBorshClient()」语义一致（含测试 mock 的 live binding）
    get client() {
      return conn?.client ?? getBorshClient();
    },
    transport,
    selectMachine: conn
      ? (callbacks) => {
          if (callbacks) conn.selectMachine.setCallbacks(callbacks);
          return conn.selectMachine;
        }
      : (callbacks) => getSelectStateMachine(callbacks),
    paneSinks: conn
      ? {
          registerPaneSink: (d, p, sink) => conn.paneSinks.registerPaneSink(d, p, sink),
          hasPaneSink: (d, p) => conn.paneSinks.hasPaneSink(d, p),
          onPaneSinkChange: (listener) => conn.paneSinks.onPaneSinkChange(listener),
          dispatchPaneReset: (d, p, o) => conn.paneSinks.dispatchPaneReset(d, p, o),
          dispatchPaneApplyHistory: (d, p, data, alt, m) =>
            conn.paneSinks.dispatchPaneApplyHistory(d, p, data, alt, m),
          dispatchPaneOutput: (d, p, data) => conn.paneSinks.dispatchPaneOutput(d, p, data),
          dispatchPaneTerminalData: (frame) => conn.paneSinks.dispatchPaneTerminalData(frame),
          dispatchPaneScreenSnapshot: (snapshot) =>
            conn.paneSinks.dispatchPaneScreenSnapshot(snapshot),
          dispatchPaneHistoryPage: (page) => conn.paneSinks.dispatchPaneHistoryPage(page),
          dispatchPaneRebase: (d, p, reason) => conn.paneSinks.dispatchPaneRebase(d, p, reason),
          dispatchPaneHistory: (d, p, tok, data, alt, m) =>
            conn.paneSinks.dispatchPaneHistory(d, p, tok, data, alt, m),
          beginPaneHistoryGate: (d, p, tok) => conn.paneSinks.beginPaneHistoryGate(d, p, tok),
          cleanupDevicePaneState: (d) => conn.paneSinks.cleanupDevicePaneState(d),
        }
      : defaultPaneSinks,
    apiClient: options.apiClient ?? defaultApiClient,
    notifications: options.notifications ?? proxyDefaultNotificationSink,
    bell: options.bell ?? defaultBell,
    t: options.t ?? ((key, params) => String(i18next.t(key, params as never))),
    host: options.host ?? defaultHost,
    storagePrefix: options.storagePrefix ?? '',
    features: {
      agentUi: options.features?.agentUi ?? true,
      watchUi: options.features?.watchUi ?? true,
      filesUi: options.features?.filesUi ?? true,
      hostManagedNotifications: options.features?.hostManagedNotifications ?? false,
      hostManagedTheme: options.features?.hostManagedTheme ?? false,
      hostManagedLocale: options.features?.hostManagedLocale ?? false,
    },
    terminalFileLinks: options.terminalFileLinks,
  };
}

/** 包内 URL 构造统一经此映射到宿主路由形状（缺省恒等） */
export function hostAppPath(host: HostServices, path: string): string {
  return host.appPath ? host.appPath(path) : path;
}
