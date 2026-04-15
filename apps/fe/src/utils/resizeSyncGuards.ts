export interface TerminalSizeSnapshot {
  cols: number;
  rows: number;
}

export interface TimedTerminalSizeSnapshot extends TerminalSizeSnapshot {
  at: number;
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
  now,
  remoteSize,
  pendingLocalSize,
  containerSize,
  ttlMs = 2000,
}: ForceLocalSizeSyncInput): boolean {
  if (!pendingLocalSize || !containerSize) {
    return false;
  }

  if (now - pendingLocalSize.at > ttlMs) {
    return false;
  }

  if (
    pendingLocalSize.cols !== containerSize.cols ||
    pendingLocalSize.rows !== containerSize.rows
  ) {
    return false;
  }

  return pendingLocalSize.cols !== remoteSize.cols || pendingLocalSize.rows !== remoteSize.rows;
}
