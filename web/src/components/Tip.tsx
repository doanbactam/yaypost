// Tooltip on Base UI: opens on hover and keyboard focus, so detail stays out of the layout until someone asks for it.
// Touch devices don't hover: put anything a phone user needs to decide in the layout or a Popover instead.
import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

export function Tip(p: { content: ReactNode; children: ReactElement; side?: "top" | "bottom" | "left" | "right" }) {
  if (!p.content) return p.children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={p.children} delay={250} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={p.side ?? "top"} sideOffset={6} collisionPadding={10} className="z-50">
          <Tooltip.Popup className="max-w-72 origin-(--transform-origin) rounded-lg bg-ink px-2.5 py-1.5 text-xs leading-relaxed text-canvas shadow-lg transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            {p.content}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
