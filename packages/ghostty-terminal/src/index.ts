export {
  createTerminalController,
  FitAddon,
  GhosttyTerminalController,
  TERMINAL_ENGINE,
} from './terminal';
export { isMacPlatform, writeTextToClipboard } from './selection-clipboard';
export { detectLinksInLine, detectLinksInWrappedLines } from './link-detector';
export type { DetectedLink, WrappedLink } from './link-detector';
export type {
  CompatibleTerminalBuffer,
  CompatibleTerminalLike,
  GhosttyCellDimensions,
  GhosttyCursorViewportRect,
  GhosttyTerminalModeSnapshot,
  GhosttyTerminalInitOptions,
  GhosttyTerminalSize,
  GhosttyTheme,
  TerminalDisposable,
} from './types';
