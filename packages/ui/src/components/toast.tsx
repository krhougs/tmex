"use client"

import { XIcon } from "lucide-react"
import * as React from "react"
import {
  toast as hotToast,
  Toaster as HotToaster,
  type Toast as HotToast,
  useToasterStore,
} from "react-hot-toast"

import { cn } from "../utils"
import { useHostLayerRef } from "./host-layer"

export type ToastLevel = "default" | "success" | "error" | "warning" | "info"

export interface ToastAction {
  label: React.ReactNode
  onClick: () => void
}

export interface ToastOptions {
  id?: string
  description?: React.ReactNode
  duration?: number
  action?: ToastAction
  closeButton?: boolean
  dismissible?: boolean
  className?: string
}

const DEFAULT_DURATION_MS = 5000
const MAX_VISIBLE_TOASTS = 3

const LEVEL_DOT_CLASS: Record<Exclude<ToastLevel, "default">, string> = {
  success: "bg-emerald-500",
  error: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
}

function ToastCard({
  t,
  level,
  message,
  options,
}: {
  t: HotToast
  level: ToastLevel
  message: React.ReactNode
  options?: ToastOptions
}) {
  const dismissible = options?.dismissible !== false
  const showClose = dismissible && options?.closeButton !== false
  const hostRef = useHostLayerRef<HTMLDivElement>({
    kind: "toast",
    input: "region",
    backdrop: "blur",
    keyboard: "fixed",
    fixed: true,
    z: 60,
  })
  return (
    <div
      ref={hostRef}
      data-testid="app-toast"
      data-level={level}
      className={cn(
        "pointer-events-auto flex w-[356px] max-w-[calc(100vw-2rem)] items-start gap-2.5 rounded-lg border border-border bg-popover px-3.5 py-3 text-sm text-popover-foreground shadow-lg",
        t.visible
          ? "animate-in fade-in slide-in-from-top-2 duration-200"
          : "animate-out fade-out slide-out-to-top-2 fill-mode-forwards duration-150",
        options?.className
      )}
    >
      {level !== "default" && (
        <span
          aria-hidden="true"
          className={cn(
            "mt-1.5 h-2 w-2 shrink-0 rounded-full",
            LEVEL_DOT_CLASS[level]
          )}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="break-words font-medium">{message}</div>
        {options?.description !== undefined && (
          <div className="mt-0.5 break-words text-xs text-muted-foreground">
            {options.description}
          </div>
        )}
      </div>
      {options?.action && (
        <button
          type="button"
          className="shrink-0 self-center rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
          onClick={options.action.onClick}
        >
          {options.action.label}
        </button>
      )}
      {showClose && (
        <button
          type="button"
          aria-label="Close"
          className="shrink-0 self-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          onClick={() => hotToast.dismiss(t.id)}
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

function show(level: ToastLevel, message: React.ReactNode, options?: ToastOptions): string {
  return hotToast.custom(
    (t) => <ToastCard t={t} level={level} message={message} options={options} />,
    {
      id: options?.id,
      duration: options?.duration ?? DEFAULT_DURATION_MS,
    }
  )
}

type ToastFn = ((message: React.ReactNode, options?: ToastOptions) => string) & {
  success: (message: React.ReactNode, options?: ToastOptions) => string
  error: (message: React.ReactNode, options?: ToastOptions) => string
  warning: (message: React.ReactNode, options?: ToastOptions) => string
  info: (message: React.ReactNode, options?: ToastOptions) => string
  custom: typeof hotToast.custom
  dismiss: (id?: string) => void
  remove: (id?: string) => void
}

export const toast: ToastFn = Object.assign(
  (message: React.ReactNode, options?: ToastOptions) => show("default", message, options),
  {
    success: (message: React.ReactNode, options?: ToastOptions) =>
      show("success", message, options),
    error: (message: React.ReactNode, options?: ToastOptions) =>
      show("error", message, options),
    warning: (message: React.ReactNode, options?: ToastOptions) =>
      show("warning", message, options),
    info: (message: React.ReactNode, options?: ToastOptions) =>
      show("info", message, options),
    custom: hotToast.custom,
    dismiss: (id?: string) => hotToast.dismiss(id),
    remove: (id?: string) => hotToast.remove(id),
  }
)

/**
 * 应用级 Toaster：安全区与桌面标题栏补偿统一走 --tmex-toast-top-inset
 * （宿主 CSS 可按平台覆写），默认回退到 --tmex-safe-area-top / env()。
 */
/**
 * react-hot-toast 没有公开的可见数量上限配置（内部 toastLimit 无 setter），
 * 官方文档推荐用 useToasterStore 手动 dismiss 超限项：toasts 新前旧后，
 * 超过上限时最旧的走正常退场动画消失。
 */
function useToastLimit(limit: number) {
  const { toasts } = useToasterStore()
  React.useEffect(() => {
    toasts
      .filter((t) => t.visible)
      .filter((_, index) => index >= limit)
      .forEach((t) => hotToast.dismiss(t.id))
  }, [toasts, limit])
}

export function AppToaster({ position = "top-right" }: { position?: "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right" }) {
  useToastLimit(MAX_VISIBLE_TOASTS)
  return (
    <HotToaster
      position={position}
      gutter={8}
      containerStyle={{
        top: "calc(12px + var(--tmex-toast-top-inset, var(--tmex-safe-area-top, env(safe-area-inset-top, 0px))))",
        right: "calc(12px + var(--tmex-safe-area-right, env(safe-area-inset-right, 0px)))",
        left: "calc(12px + var(--tmex-safe-area-left, env(safe-area-inset-left, 0px)))",
        bottom: "calc(12px + var(--tmex-safe-area-bottom, env(safe-area-inset-bottom, 0px)))",
      }}
    />
  )
}

export { useToasterStore }
