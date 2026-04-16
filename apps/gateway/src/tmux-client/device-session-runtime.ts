import type { StateSnapshotPayload } from '@tmex/shared';

import { getDeviceById } from '../db';
import type { TmuxConnectionOptions } from './connection-types';
import type { TmuxEvent } from './events';
import { LocalExternalTmuxConnection } from './local-external-connection';
import { SshExternalTmuxConnection } from './ssh-external-connection';

export interface DeviceSessionRuntimeConnection {
  connect(): Promise<void>;
  disconnect(): void;
  requestSnapshot(): void;
  sendInput(paneId: string, data: string): void;
  resizePane(paneId: string, cols: number, rows: number): void;
  selectPane(windowId: string, paneId: string): void;
  selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number): void;
  selectWindow(windowId: string): void;
  createWindow(name?: string): void;
  closeWindow(windowId: string): void;
  closePane(paneId: string): void;
  renameWindow(windowId: string, name: string): void;
}

export interface DeviceSessionRuntimeListener {
  onEvent?: (event: TmuxEvent) => void;
  onTerminalOutput?: (paneId: string, data: Uint8Array) => void;
  onTerminalHistory?: (paneId: string, data: string) => void;
  onSnapshot?: (payload: StateSnapshotPayload) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export interface DeviceSessionRuntimeOptions {
  deviceId: string;
  createConnection?: (options: TmuxConnectionOptions) => DeviceSessionRuntimeConnection;
}

function createDefaultConnection(options: TmuxConnectionOptions): DeviceSessionRuntimeConnection {
  const device = getDeviceById(options.deviceId);
  if (device?.type === 'local') {
    return new LocalExternalTmuxConnection(options);
  }
  return new SshExternalTmuxConnection(options);
}

export class DeviceSessionRuntime {
  readonly deviceId: string;

  private readonly connection: DeviceSessionRuntimeConnection;
  private readonly listeners = new Set<DeviceSessionRuntimeListener>();
  private connectPromise: Promise<void> | null = null;
  private terminated = false;
  private closeEmitted = false;
  private manualDisconnect = false;

  constructor(options: DeviceSessionRuntimeOptions) {
    this.deviceId = options.deviceId;
    const createConnection = options.createConnection ?? createDefaultConnection;

    this.connection = createConnection({
      deviceId: this.deviceId,
      onEvent: (event) => {
        this.broadcast((listener) => listener.onEvent?.(event));
      },
      onTerminalOutput: (paneId, data) => {
        this.broadcast((listener) => listener.onTerminalOutput?.(paneId, data));
      },
      onTerminalHistory: (paneId, data) => {
        this.broadcast((listener) => listener.onTerminalHistory?.(paneId, data));
      },
      onSnapshot: (payload) => {
        this.broadcast((listener) => listener.onSnapshot?.(payload));
      },
      onError: (error) => {
        this.broadcast((listener) => listener.onError?.(error));
      },
      onClose: () => {
        if (this.manualDisconnect || this.closeEmitted) {
          return;
        }
        this.closeEmitted = true;
        this.terminated = true;
        this.broadcast((listener) => listener.onClose?.());
      },
    });
  }

  subscribe(listener: DeviceSessionRuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    if (this.terminated && !this.connectPromise) {
      return Promise.reject(
        new Error(`Device session runtime already terminated: ${this.deviceId}`)
      );
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.connection.connect().catch((error) => {
      this.terminated = true;
      throw error;
    });

    return this.connectPromise;
  }

  disconnect(): void {
    if (this.terminated) {
      return;
    }

    this.terminated = true;
    this.manualDisconnect = true;
    this.connection.disconnect();
  }

  async shutdown(): Promise<void> {
    this.disconnect();
  }

  requestSnapshot(): void {
    this.connection.requestSnapshot();
  }

  sendInput(paneId: string, data: string): void {
    this.connection.sendInput(paneId, data);
  }

  resizePane(paneId: string, cols: number, rows: number): void {
    this.connection.resizePane(paneId, cols, rows);
  }

  selectPane(windowId: string, paneId: string): void {
    this.connection.selectPane(windowId, paneId);
  }

  selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number): void {
    this.connection.selectPaneWithSize(windowId, paneId, cols, rows);
  }

  selectWindow(windowId: string): void {
    this.connection.selectWindow(windowId);
  }

  createWindow(name?: string): void {
    this.connection.createWindow(name);
  }

  closeWindow(windowId: string): void {
    this.connection.closeWindow(windowId);
  }

  closePane(paneId: string): void {
    this.connection.closePane(paneId);
  }

  renameWindow(windowId: string, name: string): void {
    this.connection.renameWindow(windowId, name);
  }

  private broadcast(action: (listener: DeviceSessionRuntimeListener) => void): void {
    for (const listener of this.listeners) {
      try {
        action(listener);
      } catch (error) {
        console.error('[tmux-client] listener callback failed:', error);
      }
    }
  }
}

export function createDeviceSessionRuntime(
  options: DeviceSessionRuntimeOptions
): DeviceSessionRuntime {
  return new DeviceSessionRuntime(options);
}
