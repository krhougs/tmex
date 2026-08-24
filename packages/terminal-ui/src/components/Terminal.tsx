import { useQuery } from '@tanstack/react-query';
import { fetchFileRoots, fetchFileStat } from '@tmex/api-client';
import { PANE_MODE_ALT_SCREEN, PANE_MODE_FLAGS_PRESENT, decodePaneModes } from '@tmex/shared';
import { type TerminalFileLinksProvider, fileRoute, hostAppPath } from '@tmex/stores';
import { useRuntime, useTmuxStore, useUIStore } from '@tmex/stores/react';
import { loadTerminalFonts, resolveFontStack } from '@tmex/theme';
import type { GatewayPaneHistoryPage, GatewayPaneScreenSnapshot } from '@tmex/ws-client';
import type { PaneSink } from '@tmex/ws-client/pane-sink-registry';
import {
  type CompatibleTerminalLike,
  FitAddon,
  type GhosttyTerminalModeSnapshot,
  TERMINAL_ENGINE,
  createTerminalController,
  getGhosttyBindings,
  parseHistoryRows,
} from 'ghostty-terminal';
import { Loader2 } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  registerCursorRectGetter,
  unregisterCursorRectGetter,
} from '../utils/keyboard-cursor-bridge';
import {
  type TerminalSemanticKeyInput,
  keyboardEventToSemanticKey,
} from '../utils/terminalSemanticKey';
import { SelectionToolbar } from './SelectionToolbar';
import { TerminalSurface, type TerminalSurfaceTarget } from './TerminalSurface';
import {
  normalizeHistoryForTerminal,
  normalizeLiveOutputForTerminal,
  wrapAlternateScreenHistory,
} from './normalization';
import {
  type TerminalDiagnosticStage,
  reportTerminalDiagnostic,
  scheduleTerminalDiagnosticSamples,
  useTerminalDiagnosticsReporter,
} from './terminal-diagnostics';
import { XTERM_THEME_DARK, XTERM_THEME_LIGHT } from './theme';
import type { TerminalProps, TerminalRef } from './types';
import { useMobileTouch } from './useMobileTouch';
import { useTerminalResize } from './useTerminalResize';

const TERMINAL_SCROLLBACK = 10000;
const NORMAL_SCREEN_PREFIX = new TextEncoder().encode('\x1b[2J\x1b[H');
// history 页字节解码/编码复用同一实例（writeCanonicalSnapshot 与 prependHistory 共用）。
const HISTORY_DECODER = new TextDecoder();
const HISTORY_ENCODER = new TextEncoder();
type TerminalController = Awaited<ReturnType<typeof createTerminalController>>;

interface TerminalRenderTarget extends TerminalSurfaceTarget {
  terminal: TerminalController;
  mount: HTMLDivElement;
  liveOutputEndedWithCR: boolean;
}

type TerminalBootState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

function startsWithBytes(value: Uint8Array, prefix: Uint8Array): boolean {
  return (
    value.byteLength >= prefix.byteLength && prefix.every((byte, index) => value[index] === byte)
  );
}

function writeCanonicalSnapshot(
  target: TerminalRenderTarget,
  snapshot: GatewayPaneScreenSnapshot,
  historyPages: readonly GatewayPaneHistoryPage[]
): void {
  target.terminal.reset();
  target.liveOutputEndedWithCR = false;
  target.terminal.resize(snapshot.cols, snapshot.rows);
  // reset() 会清掉全部 DECSET 私有模式，而快照正文（capture-pane 文本）不含这些序列；
  // 必须在 reset 之后用 gateway 随快照下发的 tmux 权威位图恢复鼠标模式，否则切窗/
  // 冷启动后 TUI 的鼠标 hover/滚轮全部失灵。bit7 未置位说明位图来自旧版 gateway
  // （彼时 bit0 是 alternate screen），不能当鼠标位解码。
  if ((snapshot.modes & PANE_MODE_FLAGS_PRESENT) !== 0) {
    target.terminal.restoreModeSnapshot?.(
      terminalModesFromHistory(snapshot.modes, (snapshot.modes & PANE_MODE_ALT_SCREEN) !== 0)
    );
  }
  // 快照正文是 gateway 用 '\n' 拼接的 capture-pane 行，和 history 一样是裸 LF；直接写进
  // xterm 会阶梯式换行，必须与 history/live 两条路径一样补齐 CR。
  const body = normalizeLiveOutputForTerminal(
    startsWithBytes(snapshot.data, NORMAL_SCREEN_PREFIX) && historyPages.length > 0
      ? snapshot.data.subarray(NORMAL_SCREEN_PREFIX.byteLength)
      : snapshot.data,
    false
  ).normalized;
  if (historyPages.length === 0) {
    target.terminal.write(body);
  } else {
    target.terminal.write(NORMAL_SCREEN_PREFIX);
    for (const page of historyPages) {
      target.terminal.write(normalizeHistoryForTerminal(HISTORY_DECODER.decode(page.data)));
      // normalizeHistoryForTerminal 会吃掉页尾换行；不补回的话页与页、
      // 最后一页与快照正文会粘在同一行，整屏随之错一行。
      target.terminal.write('\r\n');
    }
    target.terminal.write(body);
  }
  target.terminal.forceFullRepaint?.();
}

function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

// history 重建时恢复的终端模式：来自 gateway 随 TermHistory 下发的 tmux 权威位图
// （capture 快照本身不含 DECSET 序列，tmux 的 mouse_*_flag 是唯一可靠来源）。
// 1016/1015/9 无 tmux format 变量、pane 内程序也从未在 tmux 下拿到过这些形态，恒
// false；1007 只影响 alt 屏滚轮行为、同样无 format 变量，alt 屏按惯例开启；alt
// screen 状态本身由 history 前缀（\x1b[?1049h）恢复，这里不设。
function terminalModesFromHistory(
  modes: number,
  alternateScreen: boolean
): GhosttyTerminalModeSnapshot {
  const flags = decodePaneModes(modes);
  return {
    mouseX10: false,
    mouseNormal: flags.mouseStandard,
    mouseButton: flags.mouseButton,
    mouseAny: flags.mouseAll,
    mouseUtf8: flags.mouseUtf8,
    mouseSgr: flags.mouseSgr,
    mouseSgrPixels: false,
    mouseUrxvt: false,
    altScroll: alternateScreen,
    altScreen1047: false,
    altScreen1049: false,
  };
}

function setE2eTerminalProbe(terminal: CompatibleTerminalLike): void {
  const g = globalThis as any;
  g.__tmexE2eXterm = terminal;
  g.__tmexE2eTerminal = terminal;
  g.__tmexE2eTerminalEngine = TERMINAL_ENGINE;
  g.__tmexE2eTerminalRenderer = terminal.getRendererKind?.() ?? null;
}

function clearE2eTerminalProbe(terminal: CompatibleTerminalLike | null): void {
  if (!terminal) {
    return;
  }

  const g = globalThis as any;
  if (g.__tmexE2eTerminal !== terminal && g.__tmexE2eXterm !== terminal) {
    return;
  }

  g.__tmexE2eXterm = null;
  g.__tmexE2eTerminal = null;
  g.__tmexE2eTerminalEngine = null;
  g.__tmexE2eTerminalRenderer = null;
  g.__tmexE2eTerminalSelectionText = null;
}

export const Terminal = forwardRef<TerminalRef, TerminalProps>(
  (
    {
      deviceId,
      paneId,
      theme,
      inputMode,
      deviceConnected,
      isSelectionInvalid,
      sizingMode = 'report',
      autoFocus = true,
      focused = true,
      onResize,
      onSync,
      onResizeSettled,
      onOpenFile,
      prepareResources,
      children,
    },
    ref
  ) => {
    const [instance, setInstance] = useState<CompatibleTerminalLike | null>(null);
    const [hasSelection, setHasSelection] = useState(false);
    const [bootState, setBootState] = useState<TerminalBootState>({ status: 'loading' });
    const [retryNonce, setRetryNonce] = useState(0);
    const sendInput = useTmuxStore((state) => state.sendInput);
    const sendKeyInput = useTmuxStore((state) => state.sendKeyInput);
    const semanticKeyInput = useTmuxStore((state) => state.semanticKeyInput);
    const mountPane = useTmuxStore((state) => state.mountPane);
    const requestPaneScreen = useTmuxStore((state) => state.requestPaneScreen);
    const fetchPaneHistory = useTmuxStore((state) => state.fetchPaneHistory);
    const terminalFontId = useUIStore((state) => state.terminalFontId);
    const terminalFontSize = useUIStore((state) => state.terminalFontSize);
    const terminalLineHeight = useUIStore((state) => state.terminalLineHeight);
    const terminalLigatures = useUIStore((state) => state.terminalLigatures);
    const { t } = useTranslation();
    const runtime = useRuntime();
    const terminalDiagnosticsReporter = useTerminalDiagnosticsReporter();

    const terminalTheme = useMemo(() => {
      switch (theme) {
        case 'light':
          return XTERM_THEME_LIGHT;
        default:
          return XTERM_THEME_DARK;
      }
    }, [theme]);

    const containerRef = useRef<HTMLDivElement>(null);
    const generationHostRef = useRef<HTMLDivElement>(null);
    const mountRef = useRef<HTMLDivElement | null>(null);
    const generationRef = useRef<TerminalSurface<TerminalRenderTarget> | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    // 最后一次由外部（分屏按 tmux layout）显式下发的权威尺寸。快照必须按其自带的
    // rows/cols 解析才不会错行，但写完后终端就停在 capture 时的尺寸上；follow 模式下
    // reportSize 直接 return，没有任何东西会把它改回来，于是排版一直乱到用户手动 resize。
    const authoritativeSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const sizingModeRef = useRef(sizingMode);
    const runPostSelectResizeRef = useRef<() => void>(() => {});
    const currentDeviceIdRef = useRef(deviceId);
    const currentPaneIdRef = useRef(paneId);
    const canWriteRef = useRef(deviceConnected && !isSelectionInvalid);
    const currentInputModeRef = useRef(inputMode);
    const currentTerminalThemeRef = useRef(terminalTheme);
    const semanticKeysDownRef = useRef(new Set<string>());
    const initialScreenRequestedRef = useRef(false);
    const hasBootedGenerationRef = useRef(false);
    const historyRequestInFlightRef = useRef(false);
    const historyRequestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const getTerminalForTouch = useCallback(() => instance, [instance]);
    useMobileTouch(containerRef, getTerminalForTouch);

    useEffect(() => {
      currentDeviceIdRef.current = deviceId;
      currentPaneIdRef.current = paneId;
    }, [deviceId, paneId]);

    useEffect(() => {
      canWriteRef.current = deviceConnected && !isSelectionInvalid;
    }, [deviceConnected, isSelectionInvalid]);

    useEffect(() => {
      currentInputModeRef.current = inputMode;
    }, [inputMode]);

    useEffect(() => {
      currentTerminalThemeRef.current = terminalTheme;
    }, [terminalTheme]);

    useEffect(() => {
      sizingModeRef.current = sizingMode;
    }, [sizingMode]);

    const sendTerminalInput = useCallback(
      (data: string) => {
        if (!data || inputMode !== 'direct') {
          return;
        }
        if (!canWriteRef.current) {
          return;
        }

        const activeDeviceId = currentDeviceIdRef.current;
        const activePaneId = currentPaneIdRef.current;
        if (!activeDeviceId || !activePaneId) {
          return;
        }

        sendInput(activeDeviceId, activePaneId, data, false);
      },
      [inputMode, sendInput]
    );

    const sendTerminalKeyInput = useCallback(
      (input: TerminalSemanticKeyInput) => {
        if (inputMode !== 'direct' || !canWriteRef.current) return;
        const activeDeviceId = currentDeviceIdRef.current;
        const activePaneId = currentPaneIdRef.current;
        if (!activeDeviceId || !activePaneId) return;
        sendKeyInput(activeDeviceId, activePaneId, input.key, input.modifiers, input.action);
      },
      [inputMode, sendKeyInput]
    );

    const {
      pendingLocalSize,
      scheduleResize,
      runPostSelectResize,
      forceResize,
      setFitAddon,
      setTerminal,
      clearPendingLocalSize,
    } = useTerminalResize({
      deviceId,
      paneId,
      deviceConnected,
      isSelectionInvalid,
      sizingMode,
      onResize,
      onSync,
      onResizeSettled,
      getContainerRect: () => {
        const el = containerRef.current;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      },
    });

    // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce is an explicit failed-resource retry trigger
    useEffect(() => {
      let cancelled = false;
      let stopDiagnosticSamples = () => {};
      let hasCommittedSnapshot = false;
      const fontFamily = resolveFontStack(terminalFontId);
      const streamDiagnostic = () => {
        const state = generationRef.current?.getDiagnosticState();
        return {
          sourceRoute: runtime.transport.sourceRoute,
          paneEpoch: state?.paneEpoch ?? null,
          // 字节直通后渲染层不再持有终端游标与客户端 replay ring
          terminalSeq: null,
          historyEpoch: state?.historyEpoch ?? null,
          historyBeforeLine: state?.historyBeforeLine ?? null,
          recoveryState: state?.recoveryState ?? ('initializing' as const),
          recoveryReason: state?.recoveryReason ?? null,
          replayBytes: 0,
          replayBytesLimit: 0,
          historyBytes: state?.historyBytes ?? 0,
          historyBytesLimit: state?.historyBytesLimit ?? 0,
          historyPages: state?.historyPages ?? 0,
          historyPagesLimit: state?.historyPagesLimit ?? 0,
        };
      };
      const diagnosticArgs = (
        stage: TerminalDiagnosticStage,
        terminal: CompatibleTerminalLike | null,
        mount: HTMLElement | null = mountRef.current
      ) => ({
        surface: 'terminal' as const,
        stage,
        terminal,
        mount,
        fontFamily,
        fontSize: terminalFontSize,
        stream: streamDiagnostic,
      });

      initialScreenRequestedRef.current = false;
      generationRef.current = null;
      setInstance(null);
      setBootState({ status: 'loading' });
      reportTerminalDiagnostic(terminalDiagnosticsReporter, diagnosticArgs('mount', null));

      void (async () => {
        try {
          await prepareResources?.();
          await loadTerminalFonts(terminalFontId, terminalFontSize);
        } catch (error) {
          reportTerminalDiagnostic(
            terminalDiagnosticsReporter,
            diagnosticArgs('font_load_failed', null)
          );
          if (!cancelled) {
            setBootState({
              status: 'error',
              message:
                error instanceof Error ? error.message : 'Terminal resources failed to load.',
            });
          }
          return;
        }
        if (cancelled) return;
        reportTerminalDiagnostic(terminalDiagnosticsReporter, diagnosticArgs('fonts_ready', null));

        const createTarget = async (): Promise<TerminalRenderTarget> => {
          let terminal: TerminalController;
          try {
            terminal = await createTerminalController({
              fontFamily,
              fontSize: terminalFontSize,
              lineHeight: terminalLineHeight,
              ligatures: terminalLigatures,
              minimumContrast: true,
              scrollback: TERMINAL_SCROLLBACK,
              theme: currentTerminalThemeRef.current,
              disableStdin: currentInputModeRef.current === 'editor',
            });
          } catch (error) {
            reportTerminalDiagnostic(
              terminalDiagnosticsReporter,
              diagnosticArgs('controller_failed', null)
            );
            throw error;
          }
          if (cancelled) {
            terminal.dispose();
            throw new Error('terminal initialization cancelled');
          }

          const host = generationHostRef.current;
          if (!host) {
            terminal.dispose();
            throw new Error('Terminal mount is unavailable.');
          }
          const mount = document.createElement('div');
          mount.className = 'absolute inset-0';
          mount.style.visibility = 'hidden';
          mount.style.pointerEvents = 'none';
          host.appendChild(mount);
          reportTerminalDiagnostic(
            terminalDiagnosticsReporter,
            diagnosticArgs('controller_ready', terminal, mount)
          );
          try {
            terminal.open(mount);
          } catch (error) {
            reportTerminalDiagnostic(
              terminalDiagnosticsReporter,
              diagnosticArgs('open_failed', terminal, mount)
            );
            terminal.dispose();
            mount.remove();
            throw error;
          }
          reportTerminalDiagnostic(
            terminalDiagnosticsReporter,
            diagnosticArgs('opened', terminal, mount)
          );
          return {
            terminal,
            mount,
            liveOutputEndedWithCR: false,
            dispose() {
              clearE2eTerminalProbe(terminal);
              terminal.dispose();
              mount.remove();
            },
          };
        };

        // 历史页离屏解析链：applyHistoryPage 同步调用 prependHistory，但解析是异步的；
        // 串行化保证页到达顺序 = 前插顺序（新页在前插区底部，更旧的页在其上）。
        let historyParseChain: Promise<void> = Promise.resolve();
        const manager = new TerminalSurface<TerminalRenderTarget>({
          createTarget,
          writeSnapshot: writeCanonicalSnapshot,
          prependHistory(target, page) {
            // 离屏解析 → 行模型前插：不进 VT 状态机、不重建终端（翻页 O(页行数)）。
            historyParseChain = historyParseChain
              .then(() => getGhosttyBindings())
              .then((bindings) =>
                parseHistoryRows(
                  bindings,
                  HISTORY_ENCODER.encode(
                    normalizeHistoryForTerminal(HISTORY_DECODER.decode(page.data))
                  ),
                  // 与快照 cols 一致：resize 会清空前插历史，此后到达的旧页按新列宽
                  // 解析无意义（epoch 校验也会挡掉），此处取终端当前 cols。
                  target.terminal.cols
                )
              )
              .then((rows) => {
                if (cancelled) return;
                // 解析期间可能发生 replace/reset（分代重建）：目标已失效则丢弃，
                // 避免旧页前插到新终端。
                if (generationRef.current?.getVisibleTarget() !== target) return;
                target.terminal.prependHistoryRows(rows);
              })
              .catch(() => {
                // 单页解析失败不影响后续页（wasm 确定性解析，失败属异常，由渲染
                // 层其它诊断兜底）。
              });
          },
          writeLive(target, data) {
            const normalized = normalizeLiveOutputForTerminal(data, target.liveOutputEndedWithCR);
            target.liveOutputEndedWithCR = normalized.endedWithCR;
            target.terminal.write(normalized.normalized);
          },
          waitForFirstRender(target) {
            target.terminal.forceFullRepaint?.();
            return afterNextPaint();
          },
          activate(target, previous) {
            if (previous) {
              previous.mount.style.visibility = 'hidden';
              previous.mount.style.pointerEvents = 'none';
            }
            target.mount.style.visibility = 'visible';
            target.mount.style.pointerEvents = 'auto';
            target.terminal.scrollToBottom();
            target.terminal.forceFullRepaint?.();
          },
          onRecoveryRequired(reason) {
            if (cancelled) return;
            const visible = generationRef.current?.getVisibleTarget();
            reportTerminalDiagnostic(
              terminalDiagnosticsReporter,
              diagnosticArgs('recovery_started', visible?.terminal ?? null, visible?.mount ?? null)
            );
            if (!hasCommittedSnapshot && runtime.transport.capabilities.atomicScreen) {
              setBootState(
                reason === 'resource_exhausted'
                  ? {
                      status: 'error',
                      message: 'Terminal rendering failed before the first screen was ready.',
                    }
                  : { status: 'loading' }
              );
            }
            const activeDeviceId = currentDeviceIdRef.current;
            const activePaneId = currentPaneIdRef.current;
            if (activeDeviceId && activePaneId) {
              runtime.stores.tmux.getState().requestPaneScreen(activeDeviceId, activePaneId);
            }
          },
          onSnapshotApplied(target, snapshot) {
            if (cancelled) return;
            mountRef.current = target.mount;
            setInstance(target.terminal);
            if (snapshot) hasCommittedSnapshot = true;
            // 快照按自带尺寸解析完毕，收敛回 tmux 权威尺寸；此后由 live 流继续。
            if (snapshot) {
              const authoritative = authoritativeSizeRef.current;
              if (sizingModeRef.current === 'follow') {
                if (
                  authoritative &&
                  (target.terminal.cols !== authoritative.cols ||
                    target.terminal.rows !== authoritative.rows)
                ) {
                  target.terminal.resize(authoritative.cols, authoritative.rows);
                  target.terminal.forceFullRepaint?.();
                }
              } else {
                runPostSelectResizeRef.current();
              }
            }
            if (snapshot) {
              reportTerminalDiagnostic(
                terminalDiagnosticsReporter,
                diagnosticArgs('generation_activated', target.terminal, target.mount)
              );
            }
            setBootState(
              runtime.transport.capabilities.atomicScreen && !snapshot
                ? { status: 'loading' }
                : { status: 'ready' }
            );
            stopDiagnosticSamples();
            stopDiagnosticSamples = scheduleTerminalDiagnosticSamples(terminalDiagnosticsReporter, {
              surface: 'terminal',
              terminal: target.terminal,
              mount: target.mount,
              fontFamily,
              fontSize: terminalFontSize,
              stream: streamDiagnostic,
            });
          },
        });
        generationRef.current = manager;
        try {
          await manager.initialize();
        } catch (error) {
          if (!cancelled) {
            setBootState({
              status: 'error',
              message: error instanceof Error ? error.message : 'Terminal failed to initialize.',
            });
          }
          return;
        }
      })();

      return () => {
        cancelled = true;
        stopDiagnosticSamples();
        const manager = generationRef.current;
        if (manager) manager.dispose();
        if (generationRef.current === manager) generationRef.current = null;
        mountRef.current = null;
        setInstance(null);
      };
    }, [
      prepareResources,
      retryNonce,
      runtime,
      terminalDiagnosticsReporter,
      terminalFontId,
      terminalFontSize,
      terminalLigatures,
      terminalLineHeight,
    ]);

    // e2e 桥指向焦点实例（分屏多实例下 autoFocus 即焦点性；单 pane 恒 true）
    useEffect(() => {
      if (!instance || !autoFocus) {
        return;
      }
      setE2eTerminalProbe(instance);
    }, [instance, autoFocus]);

    useEffect(() => {
      instance?.setFocused?.(focused);
    }, [instance, focused]);

    useEffect(() => {
      if (!instance || !('setTheme' in instance)) {
        return;
      }

      (instance as any).setTheme(terminalTheme);
    }, [instance, terminalTheme]);

    useEffect(() => {
      if (!instance || !('setDisableStdin' in instance)) {
        return;
      }

      (instance as any).setDisableStdin(inputMode === 'editor');
    }, [instance, inputMode]);

    // 注册当前终端的光标矩形 getter，供 main.tsx 键盘避让（光标对齐模式）按需读取。
    // getter 内部按聚焦判定，编辑器模式/其他终端聚焦时返回 null，宿主自动回退整页上移。
    useEffect(() => {
      if (!instance?.getCursorViewportRect) {
        return;
      }
      const getter = () => instance.getCursorViewportRect?.() ?? null;
      registerCursorRectGetter(getter);
      return () => unregisterCursorRectGetter(getter);
    }, [instance]);

    // direct 模式下终端就绪（刷新、切换 pane 导致的重新挂载）或从 editor 切回时，
    // 焦点应回到终端；移动端跳过，避免自动弹出软键盘
    useEffect(() => {
      if (!instance || inputMode !== 'direct' || !autoFocus) {
        return;
      }
      const isMobileLike = window.innerWidth < 768 || 'ontouchstart' in window;
      if (isMobileLike) {
        return;
      }
      instance.focus();
    }, [instance, inputMode, autoFocus]);

    useEffect(() => {
      runPostSelectResizeRef.current = runPostSelectResize;
    }, [runPostSelectResize]);

    const paneSink: PaneSink | null = useMemo(() => {
      if (!instance) {
        return null;
      }

      return {
        onReset: (origin) => {
          const target = generationRef.current?.getVisibleTarget();
          target?.terminal.reset();
          if (target) target.liveOutputEndedWithCR = false;
          // history-refresh（远端 resize 后的内容重建）不上报本地尺寸，
          // 避免不同视口的客户端互相抢 window 尺寸
          if (origin !== 'history-refresh') {
            runPostSelectResize();
          }
        },
        onApplyHistory: (data, alternateScreen, modes) => {
          const target = generationRef.current?.getVisibleTarget();
          if (!target) return;
          target.terminal.restoreModeSnapshot?.(terminalModesFromHistory(modes, alternateScreen));
          const payload = alternateScreen
            ? wrapAlternateScreenHistory(data)
            : normalizeHistoryForTerminal(data);
          target.terminal.write(payload);
          target.terminal.forceFullRepaint?.();
        },
        onOutput: (data, frame) => {
          generationRef.current?.write(frame ?? { deviceId, paneId, data });
        },
        onScreenSnapshot: (snapshot) => generationRef.current?.replace(snapshot),
        onHistoryPage: (page) => {
          historyRequestInFlightRef.current = false;
          if (historyRequestTimerRef.current) clearTimeout(historyRequestTimerRef.current);
          historyRequestTimerRef.current = null;
          generationRef.current?.applyHistoryPage(page);
        },
        onRebase: (reason) => generationRef.current?.rebase(reason),
      };
    }, [deviceId, instance, paneId, runPostSelectResize]);

    useEffect(() => {
      if (!paneSink || !deviceId || !paneId) {
        return;
      }
      return runtime.paneSinks.registerPaneSink(deviceId, paneId, paneSink);
    }, [paneSink, deviceId, paneId, runtime]);

    useEffect(() => {
      if (!deviceId || !paneId) return;
      return mountPane(deviceId, paneId);
    }, [deviceId, mountPane, paneId]);

    useEffect(() => {
      if (!instance || initialScreenRequestedRef.current) {
        return;
      }
      initialScreenRequestedRef.current = true;
      const isFirstGeneration = !hasBootedGenerationRef.current;
      hasBootedGenerationRef.current = true;
      // legacy 协议的首屏由挂载/选择流程推送（见 SplitTerminalArea），首代跳过以免重复拉取；
      // 字体、连字等设置变更触发的分代重建拿不到任何推送，必须主动重拉当前屏幕
      // （legacy transport 将 request-pane-screen 映射为 fetch-pane-history + reset gate）。
      if (isFirstGeneration && !runtime.transport.capabilities.atomicScreen) {
        return;
      }
      requestPaneScreen(deviceId, paneId);
    }, [deviceId, instance, paneId, requestPaneScreen, runtime]);

    useEffect(() => {
      if (!instance || !runtime.transport.capabilities.cursorHistory) return;
      const container = containerRef.current;
      if (!container) return;

      const requestOlderHistory = (event: WheelEvent): void => {
        if (event.deltaY >= 0 || historyRequestInFlightRef.current) return;
        if (instance.buffer.active.viewportY > 3) return;
        const cursor = generationRef.current?.getNextHistoryCursor();
        if (!cursor) return;

        historyRequestInFlightRef.current = true;
        fetchPaneHistory(deviceId, paneId, cursor);
        const deadlineMs = Math.min(
          60_000,
          Math.max(15_000, (runtime.transport.latencyMs ?? 0) * 8)
        );
        if (historyRequestTimerRef.current) clearTimeout(historyRequestTimerRef.current);
        historyRequestTimerRef.current = setTimeout(() => {
          historyRequestInFlightRef.current = false;
          historyRequestTimerRef.current = null;
        }, deadlineMs);
      };
      container.addEventListener('wheel', requestOlderHistory, { passive: true });
      return () => {
        container.removeEventListener('wheel', requestOlderHistory);
        historyRequestInFlightRef.current = false;
        if (historyRequestTimerRef.current) clearTimeout(historyRequestTimerRef.current);
        historyRequestTimerRef.current = null;
      };
    }, [deviceId, fetchPaneHistory, instance, paneId, runtime]);

    useEffect(() => {
      if (!instance) {
        fitAddonRef.current = null;
        setFitAddon(null);
        setTerminal(null);
        return;
      }

      const fitAddon = new FitAddon();
      instance.loadAddon(fitAddon);
      fitAddonRef.current = fitAddon;
      setFitAddon(fitAddon);
      setTerminal(instance);

      runPostSelectResize();

      return () => {
        try {
          fitAddon.dispose();
        } finally {
          fitAddonRef.current = null;
          setFitAddon(null);
          setTerminal(null);
        }
      };
    }, [instance, runPostSelectResize, setFitAddon, setTerminal]);

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      let rafId: number | null = null;
      const ro = new ResizeObserver(() => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
        rafId = requestAnimationFrame(() => {
          rafId = null;
          scheduleResize('resize');
        });
      });
      ro.observe(el);
      return () => {
        ro.disconnect();
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
      };
    }, [scheduleResize]);

    useEffect(() => {
      if (!instance || !deviceId || !paneId) return;

      const disposable = instance.onData((data) => {
        if (!deviceConnected || isSelectionInvalid) return;
        sendTerminalInput(data);
      });

      instance.attachCustomKeyEventHandler((domEvent) => {
        if (!deviceConnected || isSelectionInvalid) return true;
        if (inputMode !== 'direct') return true;

        const semanticKeyId = domEvent.code || domEvent.key;
        if (
          semanticKeyInput &&
          domEvent.type === 'keyup' &&
          semanticKeysDownRef.current.delete(semanticKeyId)
        ) {
          domEvent.preventDefault();
          return false;
        }
        if (domEvent.type !== 'keydown') return true;

        if (semanticKeyInput) {
          const input = keyboardEventToSemanticKey(domEvent);
          if (input) {
            semanticKeysDownRef.current.add(semanticKeyId);
            domEvent.preventDefault();
            sendTerminalKeyInput(input);
            return false;
          }
        }

        if (domEvent.shiftKey && domEvent.key === 'Enter') {
          domEvent.preventDefault();
          sendTerminalInput('\x1b[13;2u');
          return false;
        }

        return true;
      });

      return () => {
        disposable.dispose();
        instance.attachCustomKeyEventHandler(() => true);
        semanticKeysDownRef.current.clear();
      };
    }, [
      instance,
      deviceConnected,
      isSelectionInvalid,
      inputMode,
      sendTerminalInput,
      semanticKeyInput,
      sendTerminalKeyInput,
      deviceId,
      paneId,
    ]);

    // 终端内链接（Mac Cmd+Click / 其它 Ctrl+Click）经宿主打开外链；与连接状态无关。
    useEffect(() => {
      if (!instance?.onLinkActivated) return;
      const disposable = instance.onLinkActivated((url) => {
        void (async () => runtime.host.openExternal(url))().catch(() => {
          runtime.notifications.error(t('terminal.linkOpenFailed'));
        });
      });
      return () => disposable.dispose();
    }, [instance, runtime, t]);

    // 文件链接上下文：该设备已启用的授权根 + 当前 pane 的 cwd，注入终端做候选有效性过滤。
    // 数据与跳转面可经 runtime.terminalFileLinks 整体替换；缺省走 gateway 文件 API 与 /file/:ref 路由。
    const fileLinks = useMemo<TerminalFileLinksProvider>(
      () =>
        runtime.terminalFileLinks ?? {
          listRoots: async (forDeviceId) => {
            const res = await fetchFileRoots(runtime.apiClient);
            return res.roots
              .filter((root) => root.enabled && root.deviceId === forDeviceId)
              .map((root) => ({ id: root.id, path: root.path }));
          },
          stat: (rootId, path) => fetchFileStat(rootId, path, runtime.apiClient),
          openFile: (rootId, path) =>
            runtime.host.navigate(hostAppPath(runtime.host, fileRoute(rootId, path))),
        },
      [runtime]
    );
    const { data: fileRootsData } = useQuery({
      queryKey: ['terminal-file-links', 'roots', deviceId],
      queryFn: () => fileLinks.listRoots(deviceId),
      staleTime: 30_000,
    });
    const fileLinkRoots = useMemo(() => fileRootsData ?? [], [fileRootsData]);
    const paneCurrentPath = useTmuxStore((state) => {
      const session = state.snapshots[deviceId]?.session;
      if (!session) return undefined;
      for (const win of session.windows) {
        for (const pane of win.panes) {
          if (pane.id === paneId) return pane.currentPath;
        }
      }
      return undefined;
    });

    useEffect(() => {
      instance?.setFileLinkContext?.({
        cwd: paneCurrentPath ?? null,
        rootPaths: fileLinkRoots.map((root) => root.path),
      });
    }, [instance, paneCurrentPath, fileLinkRoots]);

    // 文件链接点击：最长前缀匹配定位 root，stat 校验存在后跳转文件预览。
    useEffect(() => {
      if (!instance?.onFileLinkActivated) return;
      const disposable = instance.onFileLinkActivated((path) => {
        const root = fileLinkRoots
          .filter((r) => path === r.path || path.startsWith(r.path === '/' ? '/' : `${r.path}/`))
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (!root) return;
        void fileLinks
          .stat(root.id, path)
          .then(() => {
            if (onOpenFile) {
              onOpenFile(root.id, path);
            } else {
              fileLinks.openFile(root.id, path);
            }
          })
          .catch(() => {
            runtime.notifications.error(t('terminal.fileLinkNotFound'));
          });
      });
      return () => disposable.dispose();
    }, [instance, fileLinkRoots, fileLinks, onOpenFile, runtime, t]);

    useEffect(() => {
      if (!instance?.onSelectionChange) {
        setHasSelection(false);
        return;
      }

      const disposable = instance.onSelectionChange((text) => {
        setHasSelection(Boolean(text));
      });

      return () => {
        disposable.dispose();
        setHasSelection(false);
      };
    }, [instance]);

    const handleCopySelection = useCallback(() => {
      if (!instance) return;
      const text = instance.getSelection?.() ?? '';
      if (!text) return;

      void runtime.host
        .writeClipboardText(text)
        .then(() => {
          runtime.notifications.success(t('terminal.copied'));
        })
        .catch(() => {
          runtime.notifications.error(t('terminal.copyFailed'));
        })
        .finally(() => {
          instance.clearSelection?.();
          instance.focus();
        });
    }, [instance, runtime, t]);

    const handlePasteClipboard = useCallback(() => {
      if (!instance) return;

      void runtime.host
        .readClipboardText()
        .then((text) => {
          if (text) {
            instance.paste(text);
          }
          instance.clearSelection?.();
          instance.focus();
        })
        .catch(() => {
          runtime.notifications.error(t('terminal.pasteFailed'));
        });
    }, [instance, runtime, t]);

    const handleDismissSelection = useCallback(() => {
      instance?.clearSelection?.();
      instance?.focus();
    }, [instance]);

    useImperativeHandle(
      ref,
      () => ({
        write: (data) => instance?.write(data),
        reset: () => {
          instance?.reset();
          const target = generationRef.current?.getVisibleTarget();
          if (target) target.liveOutputEndedWithCR = false;
        },
        scrollToBottom: () => instance?.scrollToBottom(),
        resize: (cols, rows) => {
          authoritativeSizeRef.current = { cols, rows };
          instance?.resize(cols, rows);
        },
        getTerminal: () => instance ?? null,
        getSize: () => {
          if (!instance) return null;
          return { cols: Math.max(2, instance.cols), rows: Math.max(2, instance.rows) };
        },
        runPostSelectResize: () => runPostSelectResize(),
        forceResize: () => forceResize(),
        scheduleResize: (kind, options) => scheduleResize(kind, options),
        calculateSizeFromContainer: () => {
          const container = containerRef.current;
          const term = instance;
          const fitAddon = fitAddonRef.current;
          if (!container || !term) return null;

          const rect = container.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null;

          const core = term._core;
          let cols: number;
          if (fitAddon) {
            try {
              const dims = fitAddon.proposeDimensions();
              if (dims) {
                cols = Math.max(2, dims.cols);
              } else {
                const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 9;
                cols = Math.max(2, Math.floor(rect.width / cellWidth));
              }
            } catch {
              const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 9;
              cols = Math.max(2, Math.floor(rect.width / cellWidth));
            }
          } else {
            const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 9;
            cols = Math.max(2, Math.floor(rect.width / cellWidth));
          }

          const cellHeight = core?._renderService?.dimensions?.css?.cell?.height ?? 17;
          const rows = Math.max(2, Math.floor(rect.height / cellHeight));

          return { cols, rows };
        },
        getPendingLocalSize: () => pendingLocalSize.current,
        clearPendingLocalSize,
        getCellSize: () => {
          const core = instance?._core;
          const cell = core?._renderService?.dimensions?.css?.cell;
          if (!cell?.width || !cell?.height) return null;
          return { width: cell.width, height: cell.height };
        },
      }),
      [
        clearPendingLocalSize,
        forceResize,
        instance,
        pendingLocalSize,
        runPostSelectResize,
        scheduleResize,
      ]
    );

    return (
      <div
        className="flex h-full w-full flex-col"
        style={{ backgroundColor: terminalTheme.background }}
        data-terminal-engine={TERMINAL_ENGINE}
      >
        <div ref={containerRef} className="relative min-h-0 w-full flex-1">
          <div
            ref={generationHostRef}
            className={`absolute inset-0 ${bootState.status === 'ready' ? '' : 'invisible'}`}
          />
          {bootState.status !== 'ready' && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center"
              role={bootState.status === 'error' ? 'alert' : 'status'}
              aria-live="polite"
              data-testid="terminal-boot-placeholder"
            >
              <div className="max-w-sm space-y-4">
                {bootState.status === 'loading' && (
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                )}
                <h3 className="text-lg font-medium">
                  {bootState.status === 'loading' ? t('common.loading') : bootState.message}
                </h3>
                {bootState.status === 'error' && (
                  <button
                    type="button"
                    className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
                    onClick={() => setRetryNonce((value) => value + 1)}
                  >
                    Retry terminal
                  </button>
                )}
              </div>
            </div>
          )}
          <SelectionToolbar
            visible={hasSelection}
            canPaste={inputMode === 'direct' && deviceConnected && !isSelectionInvalid}
            onCopy={handleCopySelection}
            onPaste={handlePasteClipboard}
            onDismiss={handleDismissSelection}
          />
        </div>
        {children}
      </div>
    );
  }
);

Terminal.displayName = 'Terminal';
