// A settings group: an icon and a short name next to its action, content below. No box: groups are separated by a
// hairline and spacing, so related rows read as one block without nesting containers. Plus a copyable code block.
import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { copyText } from "../lib/util.ts";
import { toastError } from "./Toasts.tsx";

export function Card(p: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <section aria-label={p.title} className="border-t border-line pt-4">
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        <span className="text-ink-3">{p.icon}</span>
        <h2 className="text-sm font-medium">{p.title}</h2>
        <div className="flex-1" />
        {p.action}
      </div>
      {p.children && <div className="mt-3 space-y-3 text-sm leading-relaxed text-ink-2">{p.children}</div>}
    </section>
  );
}

/** One setting: its name on the left, its value or control on the right, a hairline below. `aside` sits by the name. */
export function Row(p: { label: string; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 border-b border-line py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-ink">{p.label}</span>
        {p.aside}
      </div>
      <div className="flex min-w-0 justify-end">{p.children}</div>
    </div>
  );
}

export function Code({ label, value }: { label?: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {label && <p className="mb-1.5 text-xs text-ink-3">{label}</p>}
      <div className="group relative">
        <pre className="overflow-x-auto rounded-lg bg-subtle/70 py-2.5 pr-12 pl-3 font-mono text-[12.5px] leading-relaxed text-ink">{value}</pre>
        <button
          onClick={() =>
            copyText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              (e: unknown) => toastError("Couldn't copy", e),
            )
          }
          aria-label={`Copy ${label ?? "code"}`}
          className="absolute top-1.5 right-1.5 grid size-8 place-items-center rounded-md text-ink-3 opacity-60 transition-opacity group-hover:opacity-100 hover:bg-surface hover:text-ink focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        >
          {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}
