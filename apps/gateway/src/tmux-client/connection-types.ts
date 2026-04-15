import type { StateSnapshotPayload } from '@tmex/shared';

import type { TmuxEvent } from './events';

export interface TmuxConnectionOptions {
  deviceId: string;
  onEvent: (event: TmuxEvent) => void;
  onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  onTerminalHistory: (paneId: string, data: string) => void;
  onSnapshot: (payload: StateSnapshotPayload) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}
