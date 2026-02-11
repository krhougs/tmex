import type { Device, SiteSettings, StateSnapshotPayload, TmuxBellEventData } from '@tmex/shared';
import { getAllDevices, getDeviceById, getSiteSettings } from '../db';
import { eventNotifier } from '../events';
import { t } from '../i18n';
import { TmuxConnection, type TmuxConnectionOptions } from '../tmux/connection';
import { resolveBellContext } from '../tmux/bell-context';
import type { TmuxEvent } from '../tmux/parser';

interface PushConnectionEntry {
  deviceId: string;
  generation: number;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connection: TmuxConnection | null;
  lastSnapshot: StateSnapshotPayload | null;
}

interface BellNotificationContext {
  device: Device;
  settings: SiteSettings;
  bell: TmuxBellEventData;
}

interface PushSupervisorDeps {
  listDevices: () => Device[];
  getDevice: (deviceId: string) => Device | null;
  getSettings: () => SiteSettings;
  createConnection: (options: TmuxConnectionOptions) => TmuxConnection;
  notifyBell: (context: BellNotificationContext) => Promise<void>;
  fallbackReconnectDelayMs: number;
}

const defaultDeps: PushSupervisorDeps = {
  listDevices: () => getAllDevices(),
  getDevice: (deviceId) => getDeviceById(deviceId),
  getSettings: () => getSiteSettings(),
  createConnection: (options) => new TmuxConnection(options),
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
      entry.connection?.disconnect();
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
      connection: null,
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
    entry.connection?.disconnect();
    entry.connection = null;
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
    let connection: TmuxConnection;
    connection = this.deps.createConnection({
      deviceId: entry.deviceId,
      onEvent: (event) => {
        void this.handleTmuxEvent(entry.deviceId, generation, connection, event);
      },
      onTerminalOutput: () => {},
      onTerminalHistory: () => {},
      onSnapshot: (payload) => {
        this.handleSnapshot(entry.deviceId, generation, connection, payload);
      },
      onError: (err) => {
        console.error(`[push] tmux error on device ${entry.deviceId}:`, err);
      },
      onClose: () => {
        void this.handleClose(entry.deviceId, generation, connection);
      },
    });

    entry.connection = connection;

    try {
      await connection.connect();

      const latest = this.entries.get(entry.deviceId);
      if (!this.running || latest !== entry || entry.generation !== generation) {
        connection.disconnect();
        return;
      }

      entry.reconnectAttempts = 0;
      entry.lastSnapshot = null;
      connection.requestSnapshot();
    } catch (err) {
      const latest = this.entries.get(entry.deviceId);
      if (!this.running || latest !== entry || entry.generation !== generation) {
        return;
      }

      console.error(`[push] failed connecting device ${entry.deviceId}:`, err);
      entry.connection = null;
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
    entry.connection = null;
    entry.generation += 1;

    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      void this.connectEntry(entry);
    }, delayMs);
  }

  private async handleClose(deviceId: string, generation: number, connection: TmuxConnection): Promise<void> {
    const entry = this.entries.get(deviceId);
    if (!entry || entry.generation !== generation || entry.connection !== connection) {
      return;
    }

    entry.connection = null;
    this.scheduleReconnect(entry);
  }

  private handleSnapshot(
    deviceId: string,
    generation: number,
    connection: TmuxConnection,
    payload: StateSnapshotPayload
  ): void {
    const entry = this.entries.get(deviceId);
    if (!entry || entry.generation !== generation || entry.connection !== connection) {
      return;
    }

    entry.lastSnapshot = payload;
  }

  private async handleTmuxEvent(
    deviceId: string,
    generation: number,
    connection: TmuxConnection,
    event: TmuxEvent
  ): Promise<void> {
    const entry = this.entries.get(deviceId);
    if (!entry || entry.generation !== generation || entry.connection !== connection) {
      return;
    }

    if (event.type !== 'bell') {
      return;
    }

    const device = this.deps.getDevice(deviceId);
    if (!device) {
      return;
    }

    const settings = this.deps.getSettings();
    const bell = resolveBellContext({
      deviceId,
      siteUrl: settings.siteUrl,
      snapshot: entry.lastSnapshot,
      rawData: event.data,
    });

    await this.deps.notifyBell({
      device,
      settings,
      bell,
    });
  }
}

export const pushSupervisor = new PushSupervisor();
