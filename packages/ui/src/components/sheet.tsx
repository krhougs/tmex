"use client"

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import * as React from "react"

import { XIcon } from "lucide-react"
import { cn } from "../utils"
import { Button } from "./button"
import { useDismissLayerRoot } from "./dismiss-layer"
import { useHostLayerRef } from "./host-layer"

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  const dismissLayerProps = useDismissLayerRoot(props)
  return <SheetPrimitive.Root data-slot="sheet" {...props} {...dismissLayerProps} />
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({ className, ref, ...props }: SheetPrimitive.Backdrop.Props) {
  const hostRef = useHostLayerRef<HTMLDivElement>(
    { kind: "modal-backdrop", input: "modal", backdrop: "snapshot", fixed: true, z: 50 },
    ref
  )
  return (
    <SheetPrimitive.Backdrop
      ref={hostRef}
      data-slot="sheet-overlay"
      className={cn("data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-black/10 duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 z-50", className)}
      {...props}
    />
  )
}

const slideClasses = "data-[side=right]:data-closed:slide-out-to-right-10 data-[side=right]:data-open:slide-in-from-right-10 data-[side=left]:data-closed:slide-out-to-left-10 data-[side=left]:data-open:slide-in-from-left-10 data-[side=top]:data-closed:slide-out-to-top-10 data-[side=top]:data-open:slide-in-from-top-10 data-[side=bottom]:data-closed:slide-out-to-bottom-10 data-[side=bottom]:data-open:slide-in-from-bottom-10"

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  animation = "slide",
  initialFocus,
  ref,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
  animation?: "slide" | "fade" | "bottom-up" | "top-down"
}) {
  const popupRef = React.useRef<HTMLDivElement | null>(null)
  const setPopupRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      popupRef.current = node
      if (typeof ref === "function") {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    },
    [ref]
  )
  const hostRef = useHostLayerRef<HTMLDivElement>(
    { kind: "sheet", input: "region", backdrop: "blur", keyboard: "resize", fixed: true, z: 51 },
    setPopupRef
  )

  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        ref={hostRef}
        // 非键盘打开一律把焦点落在浮层本体上，避免首个输入框自动聚焦拉起虚拟键盘；
        // 键盘用户仍走默认的首个可聚焦元素，不降级可访问性。
        initialFocus={
          initialFocus ??
          ((openType) => (openType === "keyboard" ? true : popupRef.current))
        }
        className={cn("bg-background data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 fixed z-50 flex flex-col gap-4 bg-clip-padding text-sm shadow-lg transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm", animation === "slide" && slideClasses, animation === "bottom-up" && "data-open:slide-in-from-bottom-16 data-closed:slide-out-to-bottom-16", animation === "top-down" && "data-open:slide-in-from-top-16 data-closed:slide-out-to-top-16", className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("gap-0.5 p-4 flex flex-col", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("gap-2 p-4 mt-auto flex flex-col", className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-foreground text-base font-medium", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
