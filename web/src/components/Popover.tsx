// Anchored popover on Base UI: positioned against its trigger, flips and shifts to stay on screen. Focus moves in on
// open and back to the trigger on close; outside press and Esc close it.
import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ReactElement, ReactNode } from "react";
import { cx } from "../lib/util.ts";

export function Popover(p: {
  /** The button that toggles it; its own onClick should not toggle `open`. */
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  children: ReactNode;
  className?: string;
}) {
  return (
    <BasePopover.Root open={p.open} onOpenChange={(open) => p.onOpenChange(open)}>
      <BasePopover.Trigger render={p.trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner side={p.side ?? "bottom"} align={p.align ?? "start"} sideOffset={6} collisionPadding={12} className="z-30">
          <BasePopover.Popup
            data-popover
            className={cx(
              "w-80 max-w-[calc(100vw-1.5rem)] origin-(--transform-origin) rounded-xl border border-line bg-surface p-3 text-ink shadow-xl shadow-black/10 outline-none transition-[scale,opacity] duration-150 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 dark:shadow-black/50",
              p.className,
            )}
          >
            {p.children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
