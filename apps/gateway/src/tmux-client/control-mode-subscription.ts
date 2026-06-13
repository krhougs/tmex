import {
  type ControlModeBlock,
  type ControlModeNotification,
  createControlModeParser,
} from './control-mode-parser';
import {
  type PaneStreamNotification,
  type PaneStreamParser,
  type PromptMarker,
  createPaneStreamParser,
} from './pane-stream-parser';

const STRUCTURE_DEBOUNCE_MS = 150;

// 这些通知意味着会话结构（窗口/布局/活动 pane/名称）可能变化，需要刷新快照。
const STRUCTURE_NOTIFICATION_TYPES = new Set([
  'layout-change',
  'session-renamed',
  'session-window-changed',
  'sessions-changed',
  'unlinked-window-add',
  'unlinked-window-close',
  'unlinked-window-renamed',
  'window-add',
  'window-close',
  'window-pane-changed',
  'window-renamed',
]);

export interface ControlModeSubscriptionCallbacks {
  onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  onTitle: (paneId: string, title: string) => void;
  onBell: (paneId: string) => void;
  onNotification: (paneId: string, notification: PaneStreamNotification) => void;
  onPromptMarker?: (paneId: string, marker: PromptMarker) => void;
  onStructureChanged: () => void;
  onExit: (reason: string | null) => void;
  onBlockEnd?: (block: ControlModeBlock) => void;
}

export interface ControlModeSubscription {
  push(chunk: Uint8Array): void;
  end(): void;
  prunePanes(validPaneIds: ReadonlySet<string>): void;
  dispose(): void;
}

export function createControlModeSubscription(
  callbacks: ControlModeSubscriptionCallbacks
): ControlModeSubscription {
  const paneParsers = new Map<string, PaneStreamParser>();
  let structureTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStructureEmitAt = 0;
  let disposed = false;

  function getPaneParser(paneId: string): PaneStreamParser {
    const existing = paneParsers.get(paneId);
    if (existing) {
      return existing;
    }
    const parser = createPaneStreamParser({
      onTitle: (title) => callbacks.onTitle(paneId, title),
      onBell: () => callbacks.onBell(paneId),
      onNotification: (notification) => callbacks.onNotification(paneId, notification),
      onPromptMarker: (marker) => callbacks.onPromptMarker?.(paneId, marker),
    });
    paneParsers.set(paneId, parser);
    return parser;
  }

  // 首发立即触发，突发期间合并为一次尾随触发，避免 %window-renamed 等高频通知刷快照。
  function scheduleStructureChanged(): void {
    if (disposed) {
      return;
    }
    const now = Date.now();
    if (structureTimer) {
      return;
    }
    if (now - lastStructureEmitAt >= STRUCTURE_DEBOUNCE_MS) {
      lastStructureEmitAt = now;
      callbacks.onStructureChanged();
      return;
    }
    structureTimer = setTimeout(
      () => {
        structureTimer = null;
        if (disposed) {
          return;
        }
        lastStructureEmitAt = Date.now();
        callbacks.onStructureChanged();
      },
      STRUCTURE_DEBOUNCE_MS - (now - lastStructureEmitAt)
    );
  }

  function handleNotification(notification: ControlModeNotification): void {
    if (STRUCTURE_NOTIFICATION_TYPES.has(notification.type)) {
      scheduleStructureChanged();
    }
  }

  const parser = createControlModeParser({
    onOutput: (paneId, data) => {
      const output = getPaneParser(paneId).push(data);
      if (output.length > 0) {
        callbacks.onTerminalOutput(paneId, output);
      }
    },
    onNotification: handleNotification,
    onExit: (reason) => callbacks.onExit(reason),
    onBlockEnd: (block) => callbacks.onBlockEnd?.(block),
  });

  return {
    push(chunk) {
      if (disposed) {
        return;
      }
      parser.push(chunk);
    },
    end() {
      if (disposed) {
        return;
      }
      parser.end();
    },
    prunePanes(validPaneIds) {
      for (const paneId of Array.from(paneParsers.keys())) {
        if (!validPaneIds.has(paneId)) {
          paneParsers.delete(paneId);
        }
      }
    },
    dispose() {
      disposed = true;
      if (structureTimer) {
        clearTimeout(structureTimer);
        structureTimer = null;
      }
      paneParsers.clear();
    },
  };
}
