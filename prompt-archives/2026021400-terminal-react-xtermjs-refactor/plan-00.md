# 终端重构使用 react-xtermjs 计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 DevicePage 中的终端功能从直接使用 xterm.js 重构为使用 react-xtermjs，简化代码结构，保持所有现有功能。

**Architecture:** 
- 创建独立的 `Terminal` 组件封装 react-xtermjs 逻辑
- 将终端相关逻辑从 DevicePage 抽离到自定义 hooks
- DevicePage 通过 props 和 callbacks 与 Terminal 组件交互
- 保持与现有 tmuxStore 的集成方式

**Tech Stack:** React, TypeScript, react-xtermjs, @xterm/xterm, xterm-addon-fit, @xterm/addon-webgl, xterm-addon-unicode11

---

## 背景与注意事项

### 当前代码结构

**文件位置：**
- `apps/fe/src/pages/DevicePage.tsx` - 主页面（1535 行）
- `apps/fe/src/stores/tmux.ts` - WebSocket 连接和消息处理
- `apps/fe/src/stores/ui.ts` - UI 状态（inputMode、theme 等）

**当前 xterm.js 使用方式：**
```typescript
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';

// 手动管理实例
const terminal = useRef<Terminal | null>(null);
const fitAddon = useRef<FitAddon | null>(null);

// 手动初始化
const term = new Terminal({...});
term.open(container);
term.loadAddon(fit);
```

### react-xtermjs API

```typescript
import { useXTerm, XTerm } from 'react-xtermjs';

// Hook 方式
const { instance, ref } = useXTerm();

// 组件方式
<XTerm
  options={{ cursorBlink: true }}
  style={{ width: '100%', height: '100%' }}
  listeners={{ onData, onResize }}
/>
```

### 特别注意

1. **Addon 加载**：react-xtermjs 可能需要手动集成 addons
2. **Resize 逻辑**：现有复杂的 resize 防抖和同步逻辑需要保留
3. **History 加载时机**：terminal ready 后才能写入 history
4. **TypeScript 类型**：确保类型定义正确
5. **测试覆盖**：Playwright E2E 测试需要保持通过

---

## Task 清单

### Task 1: 安装依赖

**Files:**
- Modify: `apps/fe/package.json`
- Run: `bun install`

**步骤：**

1. 添加 react-xtermjs 依赖

```bash
cd apps/fe
bun add react-xtermjs @xterm/xterm
```

2. 验证现有 addon 依赖是否兼容

```bash
# 检查当前依赖
bun list xterm-addon-fit @xterm/addon-webgl xterm-addon-unicode11
```

3. Commit

```bash
git add apps/fe/package.json bun.lock
git commit -m "chore: add react-xtermjs dependency"
```

---

### Task 2: 创建 Terminal 组件基础结构

**Files:**
- Create: `apps/fe/src/components/terminal/Terminal.tsx`
- Create: `apps/fe/src/components/terminal/index.ts`
- Create: `apps/fe/src/components/terminal/types.ts`

**步骤：**

1. 创建 types.ts

```typescript
import type { Terminal as XTermTerminal } from '@xterm/xterm';

export interface TerminalProps {
  deviceId: string;
  paneId: string;
  theme: 'light' | 'dark';
  inputMode: 'direct' | 'editor';
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onReady?: (terminal: XTermTerminal) => void;
}

export interface TerminalRef {
  write: (data: string | Uint8Array) => void;
  reset: () => void;
  scrollToBottom: () => void;
  resize: (cols: number, rows: number) => void;
  getTerminal: () => XTermTerminal | null;
}
```

2. 创建基础 Terminal 组件

```typescript
import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react';
import { useXTerm } from 'react-xtermjs';
import { FitAddon } from 'xterm-addon-fit';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import type { TerminalProps, TerminalRef } from './types';

export const Terminal = forwardRef<TerminalRef, TerminalProps>(
  ({ deviceId, paneId, theme, inputMode, onData, onResize, onReady }, ref) => {
    const { instance, ref: terminalRef } = useXTerm();
    const fitAddonRef = useRef<FitAddon | null>(null);

    // 主题配置
    const xtermTheme = theme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;

    useEffect(() => {
      if (!instance) return;

      // 加载 addons
      const fit = new FitAddon();
      const unicode11 = new Unicode11Addon();
      
      instance.loadAddon(fit);
      instance.loadAddon(unicode11);

      // 尝试加载 WebGL
      try {
        const webgl = new WebglAddon();
        instance.loadAddon(webgl);
      } catch (e) {
        console.log('[xterm] WebGL not supported');
      }

      // 激活 unicode 11
      if (instance.unicode.versions.includes('11')) {
        instance.unicode.activeVersion = '11';
      }

      fitAddonRef.current = fit;
      onReady?.(instance);

      return () => {
        fitAddonRef.current = null;
      };
    }, [instance]);

    useImperativeHandle(ref, () => ({
      write: (data) => instance?.write(data),
      reset: () => instance?.reset(),
      scrollToBottom: () => instance?.scrollToBottom(),
      resize: (cols, rows) => instance?.resize(cols, rows),
      getTerminal: () => instance ?? null,
    }), [instance]);

    return (
      <div
        ref={terminalRef}
        className="h-full w-full"
        style={{ backgroundColor: xtermTheme.background }}
      />
    );
  }
);

Terminal.displayName = 'Terminal';
```

3. 创建 index.ts

```typescript
export { Terminal } from './Terminal';
export type { TerminalProps, TerminalRef } from './types';
```

4. Commit

```bash
git add apps/fe/src/components/terminal/
git commit -m "feat: create base Terminal component with react-xtermjs"
```

---

### Task 3: 迁移 Terminal 主题配置

**Files:**
- Create: `apps/fe/src/components/terminal/theme.ts`
- Modify: `apps/fe/src/components/terminal/Terminal.tsx`

**步骤：**

1. 从 DevicePage 提取主题配置

```typescript
export const XTERM_THEME_DARK = {
  background: '#0b1020',
  foreground: '#e7e9ee',
  cursor: '#e7e9ee',
  selectionBackground: 'rgba(79, 70, 229, 0.35)',
  black: '#0b1020',
  red: '#ff6b6b',
  green: '#2bd576',
  yellow: '#ffd166',
  blue: '#4f46e5',
  magenta: '#a855f7',
  cyan: '#22d3ee',
  white: '#e7e9ee',
};

export const XTERM_THEME_LIGHT = {
  background: '#f8fafc',
  foreground: '#0f172a',
  cursor: '#0f172a',
  selectionBackground: 'rgba(79, 70, 229, 0.22)',
  black: '#0f172a',
  red: '#b91c1c',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#4338ca',
  magenta: '#7e22ce',
  cyan: '#0e7490',
  white: '#0f172a',
};
```

2. 更新 Terminal.tsx 引入主题

3. Commit

```bash
git commit -m "feat: extract xterm theme configuration"
```

---

### Task 4: 创建 useTerminal hook

**Files:**
- Create: `apps/fe/src/components/terminal/useTerminal.ts`

**步骤：**

1. 创建 hook 封装终端逻辑

```typescript
import { useCallback, useRef, useEffect, useState } from 'react';
import type { Terminal as XTermTerminal } from '@xterm/xterm';
import { useTmuxStore } from '@/stores/tmux';

interface UseTerminalOptions {
  deviceId: string;
  paneId: string;
}

interface UseTerminalReturn {
  terminalRef: React.RefObject<XTermTerminal | null>;
  isReady: boolean;
  writeHistory: (data: string) => void;
  writeBinary: (data: Uint8Array) => void;
  reset: () => void;
}

export function useTerminal({ deviceId, paneId }: UseTerminalOptions): UseTerminalReturn {
  const terminalRef = useRef<XTermTerminal | null>(null);
  const [isReady, setIsReady] = useState(false);
  const historyBufferRef = useRef<Uint8Array[]>([]);
  const historyAppliedRef = useRef(false);
  const liveOutputEndedWithCR = useRef(false);

  const subscribeBinary = useTmuxStore((state) => state.subscribeBinary);
  const subscribeHistory = useTmuxStore((state) => state.subscribeHistory);
  const socketReady = useTmuxStore((state) => state.socketReady);

  // 设置 terminal ready 回调
  const onTerminalReady = useCallback((terminal: XTermTerminal) => {
    terminalRef.current = terminal;
    setIsReady(true);
  }, []);

  // 订阅 binary 数据
  useEffect(() => {
    if (!deviceId) return;

    return subscribeBinary(deviceId, (output) => {
      const normalized = normalizeLiveOutputForXterm(output, liveOutputEndedWithCR.current);
      liveOutputEndedWithCR.current = normalized.endedWithCR;

      if (!isReady || !terminalRef.current) {
        historyBufferRef.current.push(normalized.normalized.slice());
        return;
      }

      if (!historyAppliedRef.current) {
        historyBufferRef.current.push(normalized.normalized.slice());
        return;
      }

      terminalRef.current.write(normalized.normalized);
    });
  }, [deviceId, isReady, subscribeBinary]);

  // 订阅 history 数据
  useEffect(() => {
    if (!deviceId || !paneId || !socketReady) return;

    return subscribeHistory(deviceId, paneId, (data) => {
      if (historyAppliedRef.current) return;

      const term = terminalRef.current;
      if (!isReady || !term) {
        // 缓存 history
        return;
      }

      term.write(normalizeHistoryForXterm(data));
      // 写入 buffer
      historyBufferRef.current.forEach(chunk => term.write(chunk));
      historyBufferRef.current = [];
      historyAppliedRef.current = true;
    });
  }, [deviceId, paneId, socketReady, isReady, subscribeHistory]);

  // pane 切换时重置状态
  useEffect(() => {
    historyBufferRef.current = [];
    historyAppliedRef.current = false;
    liveOutputEndedWithCR.current = false;
    terminalRef.current?.reset();
  }, [deviceId, paneId]);

  const writeHistory = useCallback((data: string) => {
    terminalRef.current?.write(normalizeHistoryForXterm(data));
  }, []);

  const writeBinary = useCallback((data: Uint8Array) => {
    terminalRef.current?.write(data);
  }, []);

  const reset = useCallback(() => {
    terminalRef.current?.reset();
    historyBufferRef.current = [];
    historyAppliedRef.current = false;
    liveOutputEndedWithCR.current = false;
  }, []);

  return {
    terminalRef,
    isReady,
    writeHistory,
    writeBinary,
    reset,
    onTerminalReady,
  };
}

// 工具函数
function normalizeHistoryForXterm(data: string): string {
  if (!data) return data;
  return data.replace(/\r?\n/g, '\r\n');
}

function normalizeLiveOutputForXterm(
  data: Uint8Array,
  previousEndedWithCR: boolean
): { normalized: Uint8Array; endedWithCR: boolean } {
  let prevWasCR = previousEndedWithCR;
  let extraCRCount = 0;

  for (const byte of data) {
    if (byte === 0x0a && !prevWasCR) {
      extraCRCount += 1;
    }
    prevWasCR = byte === 0x0d;
  }

  const endedWithCR = prevWasCR;
  if (extraCRCount === 0) {
    return { normalized: data, endedWithCR };
  }

  const normalized = new Uint8Array(data.length + extraCRCount);
  let writeIndex = 0;
  prevWasCR = previousEndedWithCR;

  for (const byte of data) {
    if (byte === 0x0a && !prevWasCR) {
      normalized[writeIndex] = 0x0d;
      writeIndex += 1;
    }
    normalized[writeIndex] = byte;
    writeIndex += 1;
    prevWasCR = byte === 0x0d;
  }

  return { normalized, endedWithCR };
}
```

2. Commit

```bash
git commit -m "feat: create useTerminal hook for data handling"
```

---

### Task 5: 创建 useTerminalResize hook

**Files:**
- Create: `apps/fe/src/components/terminal/useTerminalResize.ts`

**步骤：**

1. 创建 resize 专用 hook

```typescript
import { useCallback, useRef, useEffect } from 'react';
import type { Terminal as XTermTerminal } from '@xterm/xterm';
import type { FitAddon } from 'xterm-addon-fit';

interface UseTerminalResizeOptions {
  deviceId: string;
  paneId: string;
  deviceConnected: boolean;
  isSelectionInvalid: boolean;
  onResize: (cols: number, rows: number) => void;
  onSync: (cols: number, rows: number) => void;
}

export function useTerminalResize({
  deviceId,
  paneId,
  deviceConnected,
  isSelectionInvalid,
  onResize,
  onSync,
}: UseTerminalResizeOptions) {
  const resizeRaf = useRef<number | null>(null);
  const resizeTimer = useRef<number | null>(null);
  const lastReportedSize = useRef<{ cols: number; rows: number } | null>(null);
  const pendingLocalSize = useRef<{ cols: number; rows: number; at: number } | null>(null);
  const suppressLocalResizeUntil = useRef(0);
  const postSelectResizeTimers = useRef<number[]>([]);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const reportSize = useCallback(
    (kind: 'resize' | 'sync', force = false) => {
      if (!deviceId || !paneId || !deviceConnected || isSelectionInvalid) {
        return false;
      }

      if (!force && Date.now() < suppressLocalResizeUntil.current) {
        return false;
      }

      const term = fitAddonRef.current?.terminal;
      if (!term) return false;

      fitAddonRef.current?.fit();

      const cols = Math.max(2, term.cols);
      const rows = Math.max(2, term.rows);
      const lastSize = lastReportedSize.current;

      if (!force && lastSize && lastSize.cols === cols && lastSize.rows === rows) {
        return true;
      }

      if (kind === 'sync') {
        onSync(cols, rows);
      } else {
        onResize(cols, rows);
      }

      lastReportedSize.current = { cols, rows };
      pendingLocalSize.current = { cols, rows, at: Date.now() };
      return true;
    },
    [deviceId, paneId, deviceConnected, isSelectionInvalid, onResize, onSync]
  );

  const scheduleResize = useCallback(
    (kind: 'resize' | 'sync' = 'resize', options: { immediate?: boolean; force?: boolean } = {}) => {
      const { immediate = false, force = false } = options;

      if (resizeTimer.current !== null) {
        window.clearTimeout(resizeTimer.current);
        resizeTimer.current = null;
      }

      if (resizeRaf.current !== null) {
        cancelAnimationFrame(resizeRaf.current);
        resizeRaf.current = null;
      }

      const run = () => {
        resizeRaf.current = requestAnimationFrame(() => {
          resizeRaf.current = null;
          reportSize(kind, force);
        });
      };

      if (immediate) {
        run();
        return;
      }

      resizeTimer.current = window.setTimeout(() => {
        resizeTimer.current = null;
        run();
      }, 80);
    },
    [reportSize]
  );

  const clearPostSelectResizeTimers = useCallback(() => {
    postSelectResizeTimers.current.forEach((id) => window.clearTimeout(id));
    postSelectResizeTimers.current = [];
  }, []);

  const runPostSelectResize = useCallback(() => {
    clearPostSelectResizeTimers();
    scheduleResize('sync', { immediate: true, force: true });

    const retryId = window.setTimeout(() => {
      scheduleResize('sync', { immediate: true, force: true });
    }, 60);
    postSelectResizeTimers.current.push(retryId);

    if (typeof document !== 'undefined' && 'fonts' in document && document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          scheduleResize('sync', { immediate: true, force: true });
        })
        .catch(() => {
          // ignore
        });
    }
  }, [clearPostSelectResizeTimers, scheduleResize]);

  // 清理
  useEffect(() => {
    return () => {
      clearPostSelectResizeTimers();
      if (resizeTimer.current !== null) {
        window.clearTimeout(resizeTimer.current);
      }
      if (resizeRaf.current !== null) {
        cancelAnimationFrame(resizeRaf.current);
      }
    };
  }, [clearPostSelectResizeTimers]);

  return {
    scheduleResize,
    runPostSelectResize,
    clearPostSelectResizeTimers,
    setFitAddon: (addon: FitAddon | null) => {
      fitAddonRef.current = addon;
    },
    lastReportedSize,
    pendingLocalSize,
    suppressLocalResizeUntil,
  };
}
```

2. Commit

```bash
git commit -m "feat: create useTerminalResize hook"
```

---

### Task 6: 完善 Terminal 组件

**Files:**
- Modify: `apps/fe/src/components/terminal/Terminal.tsx`
- Modify: `apps/fe/src/components/terminal/types.ts`

**步骤：**

1. 更新 Terminal 组件集成所有功能

```typescript
import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react';
import { useXTerm } from 'react-xtermjs';
import { FitAddon } from 'xterm-addon-fit';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import type { TerminalProps, TerminalRef } from './types';
import { XTERM_THEME_DARK, XTERM_THEME_LIGHT } from './theme';
import { useTerminalResize } from './useTerminalResize';
import type { XTermTerminal } from '@xterm/xterm';

export const Terminal = forwardRef<TerminalRef, TerminalProps>(
  (
    {
      deviceId,
      paneId,
      theme,
      inputMode,
      deviceConnected,
      isSelectionInvalid,
      onData,
      onResize,
      onSync,
      onReady,
    },
    ref
  ) => {
    const { instance, ref: terminalRef } = useXTerm();
    const fitAddonRef = useRef<FitAddon | null>(null);
    const xtermTheme = theme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK;

    const {
      scheduleResize,
      runPostSelectResize,
      setFitAddon,
      lastReportedSize,
      pendingLocalSize,
      suppressLocalResizeUntil,
    } = useTerminalResize({
      deviceId,
      paneId,
      deviceConnected,
      isSelectionInvalid,
      onResize,
      onSync,
    });

    // 初始化 addons
    useEffect(() => {
      if (!instance) return;

      const fit = new FitAddon();
      const unicode11 = new Unicode11Addon();

      instance.loadAddon(fit);
      instance.loadAddon(unicode11);

      try {
        const webgl = new WebglAddon();
        instance.loadAddon(webgl);
      } catch (e) {
        console.log('[xterm] WebGL not supported');
      }

      if (instance.unicode.versions.includes('11')) {
        instance.unicode.activeVersion = '11';
      }

      fitAddonRef.current = fit;
      setFitAddon(fit);

      // 初始 fit
      requestAnimationFrame(() => {
        fit.fit();
        onReady?.(instance);
      });

      return () => {
        fitAddonRef.current = null;
        setFitAddon(null);
      };
    }, [instance, onReady, setFitAddon]);

    // 主题更新
    useEffect(() => {
      if (!instance) return;
      instance.options.theme = xtermTheme;
      const core = (instance as unknown as {
        _core?: {
          renderer?: { clearTextureAtlas?: () => void };
          viewport?: { refresh: () => void };
        };
      })._core;
      core?.renderer?.clearTextureAtlas?.();
      core?.viewport?.refresh?.();
      instance.refresh(0, instance.rows - 1);
    }, [instance, xtermTheme]);

    // input mode 切换
    useEffect(() => {
      if (!instance) return;
      instance.options.disableStdin = inputMode === 'editor';
    }, [instance, inputMode]);

    // 键盘事件处理
    useEffect(() => {
      if (!instance || !onData) return;

      const disposable = instance.onData(onData);

      instance.attachCustomKeyEventHandler((domEvent) => {
        if (domEvent.type !== 'keydown') return true;
        if (inputMode !== 'direct') return true;

        if (domEvent.shiftKey && domEvent.key === 'Enter') {
          domEvent.preventDefault();
          onData('\x1b[13;2u');
          return false;
        }

        return true;
      });

      return () => {
        disposable.dispose();
        instance.attachCustomKeyEventHandler(() => true);
      };
    }, [instance, inputMode, onData]);

    // 容器 resize 监听
    useEffect(() => {
      const container = terminalRef.current?.parentElement;
      if (!container) return;

      const observer = new ResizeObserver(() => {
        fitAddonRef.current?.fit();
        if (deviceConnected && !isSelectionInvalid) {
          scheduleResize('resize');
        }
      });

      observer.observe(container);
      return () => observer.disconnect();
    }, [deviceConnected, isSelectionInvalid, scheduleResize]);

    // window resize
    useEffect(() => {
      if (!deviceConnected || isSelectionInvalid) return;

      const handleResize = () => scheduleResize('resize');
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, [deviceConnected, isSelectionInvalid, scheduleResize]);

    useImperativeHandle(ref, () => ({
      write: (data) => instance?.write(data),
      reset: () => instance?.reset(),
      scrollToBottom: () => instance?.scrollToBottom(),
      resize: (cols, rows) => instance?.resize(cols, rows),
      getTerminal: () => instance ?? null,
      runPostSelectResize,
      scheduleResize,
    }), [instance, runPostSelectResize, scheduleResize]);

    return (
      <div
        ref={terminalRef}
        className="h-full w-full"
        style={{ backgroundColor: xtermTheme.background }}
      />
    );
  }
);

Terminal.displayName = 'Terminal';
```

2. 更新 types.ts

```typescript
import type { Terminal as XTermTerminal } from '@xterm/xterm';

export interface TerminalProps {
  deviceId: string;
  paneId: string;
  theme: 'light' | 'dark';
  inputMode: 'direct' | 'editor';
  deviceConnected: boolean;
  isSelectionInvalid: boolean;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onSync?: (cols: number, rows: number) => void;
  onReady?: (terminal: XTermTerminal) => void;
}

export interface TerminalRef {
  write: (data: string | Uint8Array) => void;
  reset: () => void;
  scrollToBottom: () => void;
  resize: (cols: number, rows: number) => void;
  getTerminal: () => XTermTerminal | null;
  runPostSelectResize: () => void;
  scheduleResize: (kind: 'resize' | 'sync', options?: { immediate?: boolean; force?: boolean }) => void;
}
```

3. Commit

```bash
git commit -m "feat: complete Terminal component with all features"
```

---

### Task 7: 重构 DevicePage 使用 Terminal 组件

**Files:**
- Modify: `apps/fe/src/pages/DevicePage.tsx`

**步骤：**

1. 移除 xterm 相关 import，替换为 Terminal 组件

```typescript
// 移除
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import 'xterm/css/xterm.css';

// 添加
import { Terminal as TerminalComponent, type TerminalRef } from '@/components/terminal';
```

2. 移除 terminal 相关 refs 和状态

```typescript
// 移除
const terminal = useRef<Terminal | null>(null);
const fitAddon = useRef<FitAddon | null>(null);
const isTerminalReady = useRef(false);
// ... 其他 terminal 相关 refs
```

3. 添加 Terminal ref

```typescript
const terminalRef = useRef<TerminalRef>(null);
```

4. 重构 terminal 初始化 useEffect 为使用 Terminal 组件

5. 重构所有使用 terminal.current 的地方为 terminalRef.current

6. Commit

```bash
git commit -m "refactor: DevicePage use Terminal component"
```

---

### Task 8: 迁移移动端触摸处理

**Files:**
- Create: `apps/fe/src/components/terminal/useMobileTouch.ts`
- Modify: `apps/fe/src/components/terminal/Terminal.tsx`

**步骤：**

1. 提取移动端触摸处理逻辑

```typescript
import { useEffect, useRef } from 'react';

export function useMobileTouch(containerRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const isMobile = window.innerWidth < 768 || 'ontouchstart' in window;
    if (!isMobile) return;

    let startY = 0;
    let viewport: HTMLElement | null = container.querySelector('.xterm-viewport');
    let observer: MutationObserver | null = null;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      startY = event.touches[0]?.clientY ?? 0;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const currentY = event.touches[0]?.clientY ?? 0;
      const deltaY = currentY - startY;
      if (deltaY <= 0) return;

      const target = event.currentTarget;
      if (!(target instanceof HTMLElement)) return;
      if (!event.cancelable) return;
      if (target.scrollTop <= 0) {
        event.preventDefault();
      }
    };

    const attach = (el: HTMLElement) => {
      el.addEventListener('touchstart', handleTouchStart, { passive: true });
      el.addEventListener('touchmove', handleTouchMove, { passive: false });
    };

    const detach = (el: HTMLElement) => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
    };

    if (viewport) {
      attach(viewport);
    } else {
      observer = new MutationObserver(() => {
        const el = container.querySelector('.xterm-viewport');
        if (!(el instanceof HTMLElement)) return;
        viewport = el;
        attach(el);
        observer?.disconnect();
        observer = null;
      });
      observer.observe(container, { childList: true });
    }

    return () => {
      if (viewport) detach(viewport);
      observer?.disconnect();
    };
  }, [containerRef]);
}
```

2. Commit

```bash
git commit -m "feat: extract mobile touch handling"
```

---

### Task 9: 清理 DevicePage 代码

**Files:**
- Modify: `apps/fe/src/pages/DevicePage.tsx`

**步骤：**

1. 移除不再使用的工具函数（已移至组件内）
2. 移除 XTERM_THEME 定义（已移至 theme.ts）
3. 简化 imports
4. 验证所有功能正常工作

5. Commit

```bash
git commit -m "refactor: cleanup DevicePage terminal code"
```

---

### Task 10: 运行测试验证

**Files:**
- All test files in `apps/fe/tests/`

**步骤：**

1. 运行 E2E 测试

```bash
cd apps/fe
bun run test:e2e
```

2. 验证以下测试通过：
   - terminal-ui.spec.ts
   - mobile-terminal-interactions.spec.ts
   - devices.spec.ts

3. 如有失败，修复问题

4. Commit

```bash
git commit -m "test: verify terminal refactor with e2e tests"
```

---

### Task 11: 类型检查和构建验证

**Files:**
- All TypeScript files

**步骤：**

1. 类型检查

```bash
cd apps/fe
bunx tsc --noEmit
```

2. 构建验证

```bash
bun run build
```

3. 如有错误，修复

4. Commit

```bash
git commit -m "chore: fix type errors after refactor"
```

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| react-xtermjs API 与现有代码不兼容 | 中 | 高 | 先创建原型验证，保留回滚方案 |
| Addon 加载方式改变导致功能异常 | 中 | 中 | 完整测试所有 addon（WebGL、Fit、Unicode11）|
| Resize 逻辑重构引入 bug | 中 | 高 | 保留现有 resize 算法，仅改变封装方式 |
| Mobile 触摸处理失效 | 低 | 中 | 保留现有触摸处理逻辑，完整 E2E 测试 |
| 性能退化 | 低 | 中 | 对比重构前后性能指标 |

---

## 验收标准

1. [ ] DevicePage.tsx 行数减少 50% 以上（当前 1535 行）
2. [ ] 所有 E2E 测试通过
3. [ ] 类型检查无错误
4. [ ] 构建成功
5. [ ] 主题切换正常
6. [ ] Resize 上报正常
7. [ ] History 回显正常
8. [ ] Binary 数据实时输出正常
9. [ ] 输入模式切换正常
10. [ ] 移动端触摸滚动正常
11. [ ] iOS 键盘适配正常
