// Toasts on Base UI's global manager (callable from anywhere, including the SSE handler) and their viewport.
import { Toast } from "@base-ui/react/toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cx } from "../lib/util.ts";

export interface ToastAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: "default" | "success" | "error";
  actions?: ToastAction[];
  /** ms; 0 keeps it until dismissed. */
  duration?: number;
  /** Replaces an existing toast with the same id. */
  id?: string;
}

interface ToastData {
  actions?: ToastAction[];
}

const manager = Toast.createToastManager<ToastData>();
let seq = 0;

export function dismissToast(id: string) {
  manager.close(id);
}

export function toast(opts: ToastOptions): string {
  const id = opts.id ?? `t${++seq}`;
  manager.add({
    id,
    title: opts.title,
    description: opts.description,
    type: opts.tone ?? "default",
    priority: opts.tone === "error" ? "high" : "low",
    timeout: opts.duration ?? (opts.actions?.length ? 7000 : 3500),
    data: { actions: opts.actions },
  });
  return id;
}

export const toastError = (title: string, e: unknown) =>
  toast({ title, description: e instanceof Error ? e.message : String(e), tone: "error", duration: 7000 });

const ICONS = { success: CircleCheck, error: CircleAlert, default: Info };

function ToastList() {
  const { toasts } = Toast.useToastManager<ToastData>();
  return toasts.map((t) => {
    const tone = (t.type ?? "default") as keyof typeof ICONS;
    const Icon = ICONS[tone] ?? Info;
    return (
      <Toast.Root
        key={t.id}
        toast={t}
        className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border border-line bg-surface/95 px-4 py-3 shadow-lg shadow-black/5 backdrop-blur transition-[translate,opacity] duration-200 ease-out select-none data-ending-style:opacity-0 data-limited:hidden data-starting-style:translate-y-2 data-starting-style:opacity-0 sm:w-96 dark:shadow-black/40"
      >
        <Icon
          size={18}
          className={cx(
            "mt-0.5 shrink-0",
            tone === "success" && "text-emerald-600 dark:text-emerald-400",
            tone === "error" && "text-red-600 dark:text-red-400",
            tone === "default" && "text-ink-3",
          )}
        />
        <div className="min-w-0 flex-1">
          <Toast.Title className="text-sm font-medium" />
          <Toast.Description className="mt-0.5 text-sm break-words text-ink-2 empty:hidden" />
          {t.data?.actions && (
            <div className="mt-2 flex flex-wrap gap-2">
              {t.data.actions.map((a) => (
                <button
                  key={a.label}
                  onClick={() => {
                    a.onClick();
                    dismissToast(t.id);
                  }}
                  className={cx(
                    "rounded-md px-2.5 py-1 text-sm font-medium transition-colors",
                    a.primary ? "bg-ink text-canvas hover:opacity-90" : "bg-subtle text-ink hover:bg-line",
                  )}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <Toast.Close aria-label="Dismiss" className="-mr-1 rounded p-1 text-ink-3 hover:text-ink">
          <X size={14} />
        </Toast.Close>
      </Toast.Root>
    );
  });
}

export function Toaster() {
  return (
    <Toast.Provider toastManager={manager} limit={4}>
      <Toast.Portal>
        <Toast.Viewport
          data-toaster
          // Above the composer footer (two rows on phones), so toasts never cover its buttons.
          className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-4 max-sm:bottom-[calc(7.5rem+env(safe-area-inset-bottom))]"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
