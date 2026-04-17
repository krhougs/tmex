import type {
  Device,
  SiteSettings,
  StateSnapshotPayload,
  TmuxBellEventData,
  TmuxNotificationEventData,
} from '@tmex/shared';
import { getAllDevices, getDeviceById, getSiteSettings } from '../db';
import { eventNotifier } from '../events';
import { t } from '../i18n';
import type { DeviceSessionRuntime } from '../tmux-client/device-session-runtime';
import type { TmuxEvent } from '../tmux-client/events';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import { resolvePaneContext } from '../tmux/bell-context';

interface PushConnectionEntry {
  deviceId: string;
  generation: number;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  runtime: DeviceSessionRuntime | null;
  detachRuntime: (() => void) | null;
  lastSnapshot: StateSnapshotPayload | null;
}

interface BellNotificationContext {
  device: Device;
  settings: SiteSettings;
  bell: TmuxBellEventData;
}

interface NotificationEventContext {
  device: Device;
  settings: SiteSettings;
  notification: TmuxNotificationEventData;
}

interface PushSupervisorDeps {
  listDevices: () => Device[];
  getDevice: (deviceId: string) => Device | null;
  getSettings: () => SiteSettings;
  acquireRuntime: (deviceId: string) => Promise<DeviceSessionRuntime>;
  releaseRuntime: (deviceId: string, runtime: DeviceSessionRuntime) => Promise<void> | void;
  notifyBell: (context: BellNotificationContext) => Promise<void>;
  notifyNotification: (context: NotificationEventContext) => Promise<void>;
  fallbackReconnectDelayMs: number;
}

const defaultDeps: PushSupervisorDeps = {
  listDevices: () => getAllDevices(),
  getDevice: (deviceId) => getDeviceById(deviceId),
  getSettings: () => getSiteSettings(),
  acquireRuntime: async (deviceId) => tmuxRuntimeRegistry.acquire(deviceId),
  releaseRuntime: async (deviceId, _runtime) => {
    await tmuxRuntimeRegistry.release(deviceId);
  },
  async notifyBell(context) {
    const { device, settings, bell } = context;
    await eventNotifier.notify('terminal_bell', {
      site: {
        name: settings.siteName,
        url: settings.siteUrl,
      },
      device: {
        id: device.id,
        name: device.name,
        type: device.type,
        host: device.host,
      },
      tmux: {
        sessionName: device.session,
        windowId: bell.windowId,
        paneId: bell.paneId,
        windowIndex: bell.windowIndex,
        paneIndex: bell.paneIndex,
        paneUrl: bell.paneUrl,
      },
      payload: {
        message: t('notification.eventType.terminal_bell'),
      },
    });
  },
  async notifyNotification(context) {
    const { device, settings, notification } = context;
    await eventNotifier.notify('terminal_notification', {
      site: {
        name: settings.siteName,
        url: settings.siteUrl,
      },
      device: {
        id: device.id,
        name: device.name,
        type: device.type,
        host: device.host,
      },
      tmux: {
        sessionName: device.session,
        windowId: notification.windowId,
        paneId: notification.paneId,
        windowIndex: notification.windowIndex,
        paneIndex: notification.paneIndex,
        paneUrl: notification.paneUrl,
      },
      payload: {
        source: notification.source,
        title: notification.title,
        message: notification.body,
      },
    });
  },
  fallbackReconnectDelayMs: 60_000,
};

export interface PushSupervisorOptions {
  deps?: Partial<PushSupervisorDeps>;
}

export class PushSupervisor {
  private readonly deps: PushSupervisorDeps;
  private readonly entries = new Map<string, PushConnectionEntry>();
  private running = false;

  constructor(options: PushSupervisorOptions = {}) {
    this.deps = {
      ...defaultDeps,
      ...(options.deps ?? {}),
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    const devices = this.deps.listDevices();

    await Promise.all(devices.map((device) => this.upsert(device.id)));
  }

  async stopAll(): Promise<void> {
    this.running = false;

    for (const [deviceId, entry] of this.entries) {
      this.clearReconnectTimer(entry);
      this.teardownEntry(entry);
      this.entries.delete(deviceId);
    }
  }

  async upsert(deviceId: string): Promise<void> {
    if (!this.running) {
      return;
    }

    if (this.entries.has(deviceId)) {
      return;
    }

    const entry: PushConnectionEntry = {
      deviceId,
      generation: 1,
      reconnectAttempts: 0,
      reconnectTimer: null,
      runtime: null,
      detachRuntime: null,
      lastSnapshot: null,
    };

    this.entries.set(deviceId, entry);
    await this.connectEntry(entry);
  }

  async reconnect(deviceId: string): Promise<void> {
    const existing = this.entries.get(deviceId);
    if (existing) {
      this.teardownEntry(existing);
      this.entries.delete(deviceId);
    }

    if (!this.running) {
      return;
    }

    await this.upsert(deviceId);
  }

  remove(deviceId: string): void {
    const entry = this.entries.get(deviceId);
    if (!entry) {
      return;
    }

    this.teardownEntry(entry);
    this.entries.delete(deviceId);
  }

  private teardownEntry(entry: PushConnectionEntry): void {
    this.clearReconnectTimer(entry);
    const runtime = entry.runtime;
    entry.detachRuntime?.();
    entry.detachRuntime = null;
    entry.runtime = null;
    if (runtime) {
      void this.deps.releaseRuntime(entry.deviceId, runtime);
    }
  }

  private clearReconnectTimer(entry: PushConnectionEntry): void {
    if (!entry.reconnectTimer) {
      return;
    }

    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  private async connectEntry(entry: PushConnectionEntry): Promise<void> {
    if (!this.running) {
      return;
    }

    const current = this.entries.get(entry.deviceId);
    if (current !== entry) {
      return;
    }

    const device = this.deps.getDevice(entry.deviceId);
    if (!device) {
      this.entries.delete(entry.deviceId);
      return;
    }

    const generation = entry.generation;
    const runtime = await this.deps.acquireRuntime(entry.deviceId);
    const detachRuntime = runtime.subscribe({
      onEvent: (event) => {
        void this.handleTmuxEvent(entry.deviceId, generation, runtime, event);
      },
      onSnapshot: (payload) => {
        this.handleSnapshot(entry.deviceId, generation, runtime, payload);
      },
      onError: (error) => {
        console.error(`[push] tmux error on device ${entry.deviceId}:`, error);
      },
      onClose: () => {
        void this.handleClose(entry.deviceId, generation, runtime);
      },
    });

    entry.runtime = runtime;
    entry.detachRuntime = detachRuntime;

    try {
      await runtime.connect();

      const latest = this.entries.get(entry.deviceId);
      if (!this.running || latest !== entry || entry.generation !== generation) {
        detachRuntime();
        entry.detachRuntime = null;
        entry.runtime = null;
        await this.deps.releaseRuntime(entry.deviceId, runtime);
        return;
      }

      entry.reconnectAttempts = 0;
      entry.lastSnapshot = null;
      runtime.requestSnapshot();
    } catch (err) {
      const latest = this.entries.get(entry.deviceId);
      if (!this.running || latest !== entry || entry.generation !== generation) {
        return;
      }

      console.error(`[push] failed connecting device ${entry.deviceId}:`, err);
      detachRuntime();
      entry.detachRuntime = null;
      entry.runtime = null;
      await this.deps.releaseRuntime(entry.deviceId, runtime);
      this.scheduleReconnect(entry);
    }
  }

  private scheduleReconnect(entry: PushConnectionEntry): void {
    if (!this.running) {
      return;
    }

    const latest = this.entries.get(entry.deviceId);
    if (latest !== entry) {
      return;
    }

    const device = this.deps.getDevice(entry.deviceId);
    if (!device) {
      this.entries.delete(entry.deviceId);
      return;
    }

    const settings = this.deps.getSettings();
    const maxRetries = Math.max(0, settings.sshReconnectMaxRetries);
    const fastDelayMs = Math.max(1, settings.sshReconnectDelaySeconds) * 1000;

    const shouldUseFallback = entry.reconnectAttempts >= maxRetries;
    const delayMs = shouldUseFallback ? this.deps.fallbackReconnectDelayMs : fastDelayMs;

    if (!shouldUseFallback) {
      entry.reconnectAttempts += 1;
    }

    this.clearReconnectTimer(entry);
    entry.runtime = null;
    entry.detachRuntime = null;
    entry.generation += 1;

    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      void this.connectEntry(entry);
    }, delayMs);
  }

  private async handleClose(
    deviceId: string,
    generation: number,
    runtime: DeviceSessionRuntime
  ): Promise<void> {
    const entry = this.entries.get(deviceId);
    if (!entry || entry.generation !== generation || entry.runtime !== runtime) {
      return;
    }

    entry.detachRuntime?.();
    entry.detachRuntime = null;
    entry.runtime = null;
    await this.deps.releaseRuntime(deviceId, runtime);
    this.scheduleReconnect(entry);
  }

  private handleSnapshot(
    deviceId: string,
    generation: number,
    runtime: DeviceSessionRuntime,
    payload: StateSnapshotPayload
  ): void {
    const entry = this.entries.get(deviceId);
    if (!entry || entry.generation !== generation || entry.runtime !== runtime) {
      return;
    }

    entry.lastSnapshot = payload;
  }

  private async handleTmuxEvent(
    deviceId: string,
    generation: number,
    runtime: DeviceSessionRuntime,
    event: TmuxEvent
  ): Promise<void> {
    const entry = this.entries.get(deviceId);
    if (!entry || entry.generation !== generation || entry.runtime !== runtime) {
      return;
    }

    const device = this.deps.getDevice(deviceId);
    if (!device) {
      return;
    }

    const settings = this.deps.getSettings();
    const paneContext = resolvePaneContext({
      deviceId,
      siteUrl: settings.siteUrl,
      snapshot: entry.lastSnapshot,
      rawData: event.data,
    });

    if (event.type === 'bell') {
      await this.deps.notifyBell({
        device,
        settings,
        bell: paneContext,
      });
      return;
    }

    if (event.type === 'notification') {
      const raw = (event.data as Record<string, unknown> | undefined) ?? {};
      const title = typeof raw.title === 'string' && raw.title ? raw.title : undefined;
      const body = typeof raw.body === 'string' ? raw.body : '';
      if (!title && !body) {
        return;
      }
      const source =
        raw.source === 'osc9' || raw.source === 'osc777' || raw.source === 'osc1337'
          ? raw.source
          : 'osc9';
      await this.deps.notifyNotification({
        device,
        settings,
        notification: {
          ...paneContext,
          source,
          title,
          body,
        },
      });
    }
  }
}

export const pushSupervisor = new PushSupervisor();
