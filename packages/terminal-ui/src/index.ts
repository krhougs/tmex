// 终端 UI 包：终端组件、分屏、触控/键盘/尺寸逻辑，与终端相关的纯工具

export { Terminal } from './components/Terminal';
export {
  TerminalSurface,
  type TerminalSurfaceOptions,
  type TerminalSurfaceDiagnosticState,
  type TerminalSurfaceRecoveryState,
  type TerminalSurfaceTarget,
} from './components/TerminalSurface';
export type { TerminalProps, TerminalRef, TerminalTheme } from './components/types';
export { SplitTerminalArea } from './components/SplitTerminalArea';
export { TerminalPreview } from './components/TerminalPreview';
export {
  TerminalDiagnosticsProvider,
  collectTerminalRenderDiagnostic,
  reportTerminalDiagnostic,
  sanitizeTerminalStreamDiagnostic,
  scheduleTerminalDiagnosticSamples,
  useTerminalDiagnosticsReporter,
} from './components/terminal-diagnostics';
export type {
  TerminalDiagnosticFontStatus,
  TerminalDiagnosticRenderer,
  TerminalDiagnosticReporter,
  TerminalDiagnosticStage,
  TerminalDiagnosticSurface,
  TerminalRenderDiagnostic,
  TerminalStreamDiagnostic,
  TerminalStreamDiagnosticInput,
} from './components/terminal-diagnostics';
export { PaneSwitcherMenu } from './components/PaneSwitcherMenu';
export { SelectionToolbar } from './components/SelectionToolbar';
export {
  XTERM_THEME_DARK,
  XTERM_THEME_LIGHT,
  XTERM_THEME_MIDNIGHT_AMETHYST,
  XTERM_THEME_DAWN_AMETHYST,
  XTERM_FONT_FAMILY,
  TERMINAL_EMBEDDED_FONT_FAMILIES,
  ensureTerminalFontLoaded,
  getTmuxWindowStyle,
} from './components/theme';
export { useMobileTouch } from './components/useMobileTouch';
export { useTerminalResize } from './components/useTerminalResize';
export * from './components/normalization';
export * from './components/splitLayoutGeometry';

export * from './utils/keyboard-cursor-bridge';
export * from './utils/virtualKeyboard';
export * from './utils/terminalKeySequence';
export * from './utils/terminalSemanticKey';
export * from './utils/resizeSyncGuards';
export * from './utils/selectionGuards';

export * from './hooks/use-keyboard-avoidance';
