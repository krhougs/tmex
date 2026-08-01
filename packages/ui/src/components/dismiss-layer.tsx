'use client';

import * as React from 'react';

/**
 * 瞬态浮层的关闭栈：为宿主环境（硬件返回键、嵌入式 shell 等）提供一个
 * 「关掉最上面那层」的统一入口，避免每个宿主各自去猜当前开着哪些浮层。
 *
 * 栈是模块级数组而非 React context：浮层可能挂在任意 portal 树上，
 * 注册顺序即打开顺序，天然满足 LIFO。
 */

interface DismissLayer {
  dismiss: () => void;
}

const layers: DismissLayer[] = [];
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of [...listeners]) {
    listener();
  }
}

function registerDismissLayer(dismiss: () => void): () => void {
  const layer: DismissLayer = { dismiss };
  layers.push(layer);
  notifyListeners();

  let unregistered = false;
  return () => {
    if (unregistered) {
      return;
    }
    unregistered = true;
    const index = layers.lastIndexOf(layer);
    if (index !== -1) {
      layers.splice(index, 1);
    }
    notifyListeners();
  };
}

function dismissTopDismissLayer(): boolean {
  const top = layers[layers.length - 1];
  if (!top) {
    return false;
  }
  top.dismiss();
  notifyListeners();
  return true;
}

function getDismissLayerCount(): number {
  return layers.length;
}

function subscribeDismissLayers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useDismissLayer(open: boolean, dismiss: () => void): void {
  const dismissRef = React.useRef(dismiss);
  React.useEffect(() => {
    dismissRef.current = dismiss;
  });

  React.useEffect(() => {
    if (!open) {
      return;
    }
    return registerDismissLayer(() => dismissRef.current());
  }, [open]);
}

interface DismissLayerRootActions {
  close: () => void;
}

interface DismissLayerRootDetails {
  isCanceled: boolean;
}

interface DismissLayerRootProps<
  Actions extends DismissLayerRootActions,
  Details extends DismissLayerRootDetails,
> {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  actionsRef?: React.RefObject<Actions | null> | undefined;
  onOpenChange?: ((open: boolean, details: Details) => void) | undefined;
}

/**
 * 把一个 Base UI 风格的 Root（`open` / `defaultOpen` / `onOpenChange` / `actionsRef`）
 * 接进关闭栈：返回的 props 覆盖到 Root 上即可，`open` 与 `onOpenChange` 语义纯透传。
 * `actionsRef` 与调用方自带的合并，两边都拿得到实例。
 */
function useDismissLayerRoot<
  Actions extends DismissLayerRootActions,
  Details extends DismissLayerRootDetails,
>({ open, defaultOpen, actionsRef, onOpenChange }: DismissLayerRootProps<Actions, Details>) {
  const localActionsRef = React.useRef<Actions | null>(null);
  const [mirrorOpen, setMirrorOpen] = React.useState(defaultOpen ?? false);
  const resolvedOpen = open ?? mirrorOpen;

  useDismissLayer(resolvedOpen === true, () => {
    localActionsRef.current?.close();
  });

  const mergedActionsRef = React.useMemo<React.RefObject<Actions | null>>(
    () => ({
      get current() {
        return localActionsRef.current;
      },
      set current(value: Actions | null) {
        localActionsRef.current = value;
        if (actionsRef) {
          actionsRef.current = value;
        }
      },
    }),
    [actionsRef]
  );

  const handleOpenChange = React.useCallback(
    (next: boolean, details: Details) => {
      onOpenChange?.(next, details);
      if (!details.isCanceled) {
        setMirrorOpen(next);
      }
    },
    [onOpenChange]
  );

  return { actionsRef: mergedActionsRef, onOpenChange: handleOpenChange };
}

export {
  registerDismissLayer,
  dismissTopDismissLayer,
  getDismissLayerCount,
  subscribeDismissLayers,
  useDismissLayer,
  useDismissLayerRoot,
};
