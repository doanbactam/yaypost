// Modal dialog on Base UI: focus trap, scroll lock, Esc and outside-press close, focus back to the opener.
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/util.ts";

export const backdrop =
  "fixed inset-0 z-40 min-h-dvh bg-black/30 backdrop-blur-[2px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-[-webkit-touch-callout:none]:absolute";
export const popup =
  "fixed left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-line bg-surface text-ink shadow-2xl outline-none transition-[scale,opacity] duration-150 ease-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0";

export function Dialog(p: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  return (
    <BaseDialog.Root open onOpenChange={(open) => !open && p.onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdrop} />
        <BaseDialog.Popup
          className={cx(popup, "top-1/2 max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))] -translate-y-1/2 overflow-y-auto p-5", p.className)}
        >
          {/* The title names the dialog for screen readers; on screen the content and its buttons say what it is. */}
          <BaseDialog.Title className="sr-only">{p.title}</BaseDialog.Title>
          <div className="mb-3 flex justify-end">
            <BaseDialog.Close aria-label="Close" className="-mt-1 -mr-1 rounded-md p-1 text-ink-3 hover:bg-subtle hover:text-ink">
              <X size={16} />
            </BaseDialog.Close>
          </div>
          {p.children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
