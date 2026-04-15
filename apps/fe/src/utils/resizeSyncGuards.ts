export interface TerminalSizeSnapshot {
  cols: number;
  rows: number;
}

export interface TimedTerminalSizeSnapshot extends TerminalSizeSnapshot {
  at: number;
}

interface ViewportRestoreSyncInput {
  currentSize: TerminalSizeSnapshot;
  containerSize: TerminalSizeSnapshot;
  force?: boolean;
}

interface RemotePaneSizeGuardInput {
  now: number;
  remoteSize: TerminalSizeSnapshot;
  pendingLocalSize: TimedTerminalSizeSnapshot | null;
  ttlMs?: number;
}

export function shouldApplyRemotePaneSize({
  now,
  remoteSize,
  pendingLocalSize,
  ttlMs = 2000,
}: RemotePaneSizeGuardInput): boolean {
  if (!pendingLocalSize) {
    return true;
  }

  if (now - pendingLocalSize.at > ttlMs) {
    return true;
  }

  return pendingLocalSize.cols === remoteSize.cols && pendingLocalSize.rows === remoteSize.rows;
}

interface ForceLocalSizeSyncInput extends RemotePaneSizeGuardInput {
  containerSize: TerminalSizeSnapshot | null;
}

export function shouldForceLocalSizeSync({
  now: _now,
  remoteSize: _remoteSize,
  pendingLocalSize: _pendingLocalSize,
  containerSize: _containerSize,
  ttlMs: _ttlMs = 2000,
}: ForceLocalSizeSyncInput): boolean {
  return false;
}

export function shouldSyncOnViewportRestore({
  currentSize,
  containerSize,
  force = false,
}: ViewportRestoreSyncInput): boolean {
  if (force) {
    return true;
  }

  return currentSize.cols !== containerSize.cols || currentSize.rows !== containerSize.rows;
}
