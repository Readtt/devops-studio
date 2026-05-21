"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 200,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

type TooltipContentProps = React.ComponentProps<typeof TooltipPrimitive.Content> & {
  /** "pill" (default): inverted-color one-liner. "panel": popover-style
   *  surface for richer content (key/value sheets, multi-line prose). The
   *  panel variant inherits popover bg + text colors so muted-foreground,
   *  borders, and font-sans paragraphs all read normally. */
  variant?: "pill" | "panel"
}

function TooltipContent({
  className,
  sideOffset = 6,
  variant = "pill",
  children,
  ...props
}: TooltipContentProps) {
  const isPanel = variant === "panel"
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 origin-(--radix-tooltip-content-transform-origin) shadow-lg data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          isPanel
            ? // Popover-skinned surface for richer content. Flowing block layout
              // so multi-line copy wraps naturally; popover/text colors so
              // muted-foreground, mono accents and borders all read correctly.
              "block w-fit max-w-[360px] rounded-lg border border-border/60 bg-popover text-popover-foreground ring-1 ring-foreground/5"
            : // Editor-voice pill: inverted color one-liner. Tight tracking
              // keeps it feeling like the app speaking back, not another card.
              "inline-flex w-fit max-w-xs items-center gap-1 rounded-md bg-foreground px-2 py-1 font-sans text-[10.5px] font-medium tracking-tight text-background has-data-[slot=kbd]:pr-1.5",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          className={isPanel ? "fill-popover" : "fill-foreground"}
          width={9}
          height={4}
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
