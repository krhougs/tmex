import type { Device, EventType, SiteSettings, TmuxWindow, WebhookEvent } from '@tmex/shared';
import { getSiteSettings } from '../db';
import type { LifecycleEventEmitter } from './connection-types';
import { diffSnapshotClosures } from './snapshot-diff';

export interface LifecycleEmitterContext {
  getDevice: () => Device | null;
  getSessionName: () => string;
  isEmittable: () => boolean;
  getSnapshotWindows: () => ReadonlyMap<string, TmuxWindow>;
  notifyEvent?: LifecycleEventEmitter;
  settingsProvider?: () => SiteSettings;
  resolveCustomName?: (kind: 'window' | 'pane', nativeId: string) => string | undefined;
}

// local/ssh 两连接类共享的生命周期事件发射器。发射是旁路观测，任何一步失败
//（settings 读取、事件回调）都不允许影响连接主控制流，整体兜底只记日志。
export class ConnectionLifecycleEmitter {
  private sessionClosedEmittedFlag = false;

  constructor(private readonly ctx: LifecycleEmitterContext) {}

  reset(): void {
    this.sessionClosedEmittedFlag = false;
  }

  // 本次连接是否已因 session gone 发出 session_closed。断开告警桥据此
  // 抑制同一物理事件的 device_disconnect，避免双发。
  get sessionClosedEmitted(): boolean {
    return this.sessionClosedEmittedFlag;
  }

  emit(eventType: EventType, tmux: WebhookEvent['tmux'], payload?: Record<string, unknown>): void {
    const notifyEvent = this.ctx.notifyEvent;
    if (!notifyEvent) {
      return;
    }
    try {
      const device = this.ctx.getDevice();
      if (!device) {
        return;
      }
      const settings = (this.ctx.settingsProvider ?? getSiteSettings)();
      notifyEvent(eventType, {
        site: { name: settings.siteName, url: settings.siteUrl },
        device: { id: device.id, name: device.name, type: device.type, host: device.host },
        tmux,
        payload,
      });
    } catch (err) {
      console.error(`[tmux-client] lifecycle event emit failed (${eventType}):`, err);
    }
  }

  notifySessionClosed(message: string): void {
    if (this.sessionClosedEmittedFlag) {
      return;
    }
    this.sessionClosedEmittedFlag = true;
    this.emit(
      'session_closed',
      { sessionName: this.ctx.getSessionName() },
      { message: message.split(/\r?\n/)[0]?.trim() }
    );
  }

  notifySessionCreated(): void {
    this.emit('session_created', { sessionName: this.ctx.getSessionName() });
  }

  // 快照 diff 产生 window/pane 关闭事件。首帧（prev 为空）、无效快照（next 为空）与
  // 断开路径一律跳过，避免误报。
  emitSnapshotClosures(prev: ReadonlyMap<string, TmuxWindow>): void {
    const next = this.ctx.getSnapshotWindows();
    if (prev.size === 0 || next.size === 0 || !this.ctx.isEmittable()) {
      return;
    }
    const sessionName = this.ctx.getSessionName();
    const { closedWindows, closedPanes } = diffSnapshotClosures(prev, next);
    const windowDisplayName = (window: TmuxWindow) =>
      this.ctx.resolveCustomName?.('window', window.id) ?? window.name;
    for (const window of closedWindows) {
      this.emit(
        'tmux_window_close',
        { sessionName, windowId: window.id, windowIndex: window.index },
        { windowName: windowDisplayName(window) }
      );
    }
    for (const { pane, window } of closedPanes) {
      this.emit(
        'tmux_pane_close',
        {
          sessionName,
          windowId: window.id,
          windowIndex: window.index,
          paneId: pane.id,
          paneIndex: pane.index,
          // 快照不含改名 overlay，从 ctx 注入的 projection 查询取（用户改名优先）
          paneTitle: this.ctx.resolveCustomName?.('pane', pane.id) ?? pane.title,
          paneCurrentCommand: pane.currentCommand,
          paneCurrentPath: pane.currentPath,
        },
        { windowName: windowDisplayName(window) }
      );
    }
  }
}
