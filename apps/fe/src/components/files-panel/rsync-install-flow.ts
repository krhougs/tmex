import i18n from '@/i18n';
import { bridgeNavigate, bridgeOpenMobileSidebar } from '@/lib/flow-bridges';
import { useAgentStore } from '@/stores/agent';
import { useTmuxStore } from '@/stores/tmux';
import { useUIStore } from '@/stores/ui';
import { encodePaneIdForUrl } from '@/utils/tmuxUrl';
import { toast } from 'sonner';

const CONNECT_TIMEOUT_MS = 12_000;
const WINDOW_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 120;

// 模块级锁：agent 编排（连接→建窗→起草→导航）是一次性、不可被其它操作打断的串行流程。
// rsync 自动安装与「发送到 Agent」共用同一把锁，避免并发建窗/起草互相覆盖。
let agentOrchestrationInProgress = false;

function windowIdsOf(deviceId: string): Set<string> {
  const windows = useTmuxStore.getState().snapshots[deviceId]?.session?.windows ?? [];
  return new Set(windows.map((w) => w.id));
}

function findNewWindow(
  deviceId: string,
  before: Set<string>
): { windowId: string; paneId: string; paneTitle: string | null } | null {
  const windows = useTmuxStore.getState().snapshots[deviceId]?.session?.windows ?? [];
  for (const w of windows) {
    if (!before.has(w.id) && w.panes.length > 0) {
      const pane = w.panes.find((p) => p.active) ?? w.panes[0];
      return { windowId: w.id, paneId: pane.id, paneTitle: pane.title ?? null };
    }
  }
  return null;
}

async function pollUntil<T>(fn: () => T | null, timeoutMs: number): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

export function buildRsyncInstallPrompt(deviceLabel: string, remote: boolean): string {
  return i18n.t('files.install.prompt', {
    device: deviceLabel,
    scope: remote ? i18n.t('files.install.scopeRemote') : i18n.t('files.install.scopeLocal'),
  });
}

export function buildSendToAgentPrompt(path: string): string {
  return i18n.t('files.sendToAgent.prompt', { path });
}

// 通用 agent 编排：确保设备连接 → 建窗 → 等就绪 → 起草（预填 prompt）→ 导航 → 切 agent → 手机强开 sidebar。
// 顺序不可调换：必须先 startDraft 再 bridgeNavigate，否则路由变化触发的自动起草会覆盖预填 prompt。
export async function openAgentInNewWindowWithPrompt(
  deviceId: string,
  promptText: string
): Promise<void> {
  if (agentOrchestrationInProgress) return; // 不被打断、不重入
  agentOrchestrationInProgress = true;
  try {
    const tmux = useTmuxStore.getState();

    // 1. 设备可能仅用于 rsync 文件浏览而未连接 tmux，先连接
    if (!tmux.connectedDevices.has(deviceId)) {
      tmux.connectDevice(deviceId);
      const connected = await pollUntil(
        () => (useTmuxStore.getState().snapshots[deviceId]?.session ? true : null),
        CONNECT_TIMEOUT_MS
      );
      if (!connected) {
        toast.error(i18n.t('files.agentLaunch.connectFailed'));
        return;
      }
    }

    // 2. 记录现有窗口 → 建窗 → 等待「新窗口出现且 pane 就绪」（snapshot diff，自带超时）
    const before = windowIdsOf(deviceId);
    tmux.createWindow(deviceId);
    const win = await pollUntil(() => findNewWindow(deviceId, before), WINDOW_TIMEOUT_MS);
    if (!win) {
      toast.error(i18n.t('files.agentLaunch.windowFailed'));
      return;
    }

    // 3. 先起草（含预填 prompt）→ 再导航 → 切 agent → 手机强开 sidebar
    useAgentStore.getState().startDraft(deviceId, win.paneId, win.paneTitle, promptText);
    bridgeNavigate(
      `/devices/${deviceId}/windows/${win.windowId}/panes/${encodePaneIdForUrl(win.paneId)}`,
      { replace: true }
    );
    useUIStore.getState().setSidebarTab('agent');
    bridgeOpenMobileSidebar();
  } finally {
    agentOrchestrationInProgress = false;
  }
}

// rsync 自动安装：在设备上新建窗口并预填安装引导 prompt（薄封装）。
export function triggerRsyncInstall(deviceId: string, promptText: string): Promise<void> {
  return openAgentInNewWindowWithPrompt(deviceId, promptText);
}

// 发送文件/文件夹路径到 Agent：在所属设备上新建窗口并把该绝对路径预填进 agent 输入框。
export function sendPathToAgent(deviceId: string, absPath: string): Promise<void> {
  return openAgentInNewWindowWithPrompt(deviceId, buildSendToAgentPrompt(absPath));
}
