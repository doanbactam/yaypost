// Tab strip on Base UI (roving focus, arrow keys, ARIA). Panels stay with the caller: it renders by `value`.
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";
import { cx } from "../lib/util.ts";

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

const LIST = {
  segmented: "flex items-center gap-0.5 rounded-lg border border-line p-0.5",
  underline: "flex gap-1 border-b border-line",
};
const TAB = {
  segmented: "flex items-center gap-1.5 rounded-md font-medium whitespace-nowrap text-ink-3 transition-colors hover:text-ink data-active:bg-subtle data-active:text-ink",
  underline: "-mb-px flex h-9 items-center gap-1.5 border-b-2 border-transparent px-3 text-sm text-ink-2 transition-colors hover:text-ink data-active:border-ink data-active:font-medium data-active:text-ink",
};

export function Tabs<T extends string>(p: {
  value: T;
  onChange: (value: T) => void;
  tabs: TabItem<T>[];
  label: string;
  variant?: "segmented" | "underline";
  size?: "sm" | "md";
  /** Stretch tabs to fill the strip. */
  fill?: boolean;
  className?: string;
}) {
  const variant = p.variant ?? "segmented";
  return (
    <BaseTabs.Root value={p.value} onValueChange={(v) => p.onChange(v as T)}>
      <BaseTabs.List activateOnFocus aria-label={p.label} className={cx(LIST[variant], p.className)}>
        {p.tabs.map((t) => (
          <BaseTabs.Tab
            key={t.value}
            value={t.value}
            title={t.title}
            className={cx(
              TAB[variant],
              variant === "segmented" && (p.size === "sm" ? "h-7 shrink-0 px-2 text-xs" : "h-8 px-3 text-sm"),
              p.fill && "flex-1 justify-center",
            )}
          >
            {t.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
    </BaseTabs.Root>
  );
}
