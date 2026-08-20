"use client"

import * as React from "react"

export type HostLayerKind =
  | "modal-backdrop"
  | "dialog"
  | "sheet"
  | "popover"
  | "toast"
  | "overlay"
  | "drag-shield"
  | "drag-feedback"
  | "window-drag"
  | "input-region"

export type HostLayerInput =
  | "modal"
  | "region"
  | "passthrough"
  | "focus-preserving"
  | "window-drag"

export type HostLayerBackdrop = "snapshot" | "blur" | "none"
export type HostLayerKeyboard = "fixed" | "lift" | "follow" | "resize"

export interface HostLayerDescriptor {
  kind: HostLayerKind
  input: HostLayerInput
  backdrop: HostLayerBackdrop
  keyboard?: HostLayerKeyboard
  fixed?: boolean
  z?: number
}

export interface HostLayerEntry extends HostLayerDescriptor {
  id: string
  element: HTMLElement
}

export interface HostLayerRegistry {
  upsert(entry: HostLayerEntry): void
  remove(id: string): void
}

const HostLayerContext = React.createContext<HostLayerRegistry | null>(null)

export function HostLayerProvider({
  registry,
  children,
}: {
  registry: HostLayerRegistry
  children: React.ReactNode
}) {
  return (
    <HostLayerContext.Provider value={registry}>
      {children}
    </HostLayerContext.Provider>
  )
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value)
  else if (ref) ref.current = value
}

export function useHostLayerRef<T extends HTMLElement>(
  descriptor: HostLayerDescriptor,
  forwardedRef?: React.Ref<T>
): React.RefCallback<T> {
  const registry = React.useContext(HostLayerContext)
  const id = React.useId()
  const elementRef = React.useRef<T | null>(null)
  const { kind, input, backdrop, keyboard, fixed, z } = descriptor

  React.useLayoutEffect(() => {
    const element = elementRef.current
    if (!registry || !element) return
    registry.upsert({ id, element, kind, input, backdrop, keyboard, fixed, z })
    return () => registry.remove(id)
  }, [registry, id, kind, input, backdrop, keyboard, fixed, z])

  return React.useCallback(
    (element: T | null) => {
      elementRef.current = element
      assignRef(forwardedRef, element)
    },
    [forwardedRef]
  )
}

export function HostLayerElement({
  kind,
  input,
  backdrop,
  keyboard,
  fixed,
  z,
  ref,
  ...props
}: React.ComponentProps<"div"> & HostLayerDescriptor) {
  const hostRef = useHostLayerRef<HTMLDivElement>(
    { kind, input, backdrop, keyboard, fixed, z },
    ref
  )
  return <div ref={hostRef} {...props} />
}
