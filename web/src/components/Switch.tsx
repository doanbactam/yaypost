// On/off switch on Base UI. A native button, so a sibling <label htmlFor={id}> or `label` names it.
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type { ReactNode } from "react";

export function Switch(p: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; id?: string; label?: string; children?: ReactNode }) {
  return (
    <BaseSwitch.Root
      nativeButton
      render={<button type="button" />}
      id={p.id}
      checked={p.checked}
      onCheckedChange={(c) => p.onChange(c)}
      disabled={p.disabled}
      aria-label={p.label}
      className="relative flex h-6 w-10 shrink-0 items-center rounded-full bg-line-strong transition-colors data-checked:bg-emerald-500 data-disabled:cursor-not-allowed data-disabled:opacity-50"
    >
      <BaseSwitch.Thumb className="grid size-5 translate-x-0.5 place-items-center rounded-full bg-white shadow-sm transition-transform data-checked:translate-x-[18px]">
        {p.children}
      </BaseSwitch.Thumb>
    </BaseSwitch.Root>
  );
}
