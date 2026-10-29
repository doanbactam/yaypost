// Checkbox on Base UI; wrap it in a <label> with its text.
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";
import { cx } from "../lib/util.ts";

export function Checkbox(p: { checked: boolean; onChange: (checked: boolean) => void; className?: string }) {
  return (
    <BaseCheckbox.Root
      checked={p.checked}
      onCheckedChange={(c) => p.onChange(c)}
      className={cx(
        "grid size-4 shrink-0 place-items-center rounded border border-line-strong bg-surface text-canvas transition-colors data-checked:border-ink data-checked:bg-ink",
        p.className,
      )}
    >
      <BaseCheckbox.Indicator className="data-unchecked:hidden">
        <Check size={12} strokeWidth={3} />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}
