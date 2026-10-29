// The server's timezone as a button: opens a searchable list (city, local time now, GMT offset), the device's own
// zone first. Saving moves posting slots and the digest with it; scheduled posts keep their moment.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Laptop } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { cx } from "../lib/util.ts";
import { Popover } from "./Popover.tsx";
import { toast, toastError } from "./Toasts.tsx";

const pretty = (tz: string) => tz.replace(/_/g, " ");
const city = (tz: string) => pretty(tz.split("/").at(-1)!);
const region = (tz: string) => pretty(tz.split("/").slice(0, -1).join(" / "));
const offset = (tz: string) =>
  new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
const timeIn = (tz: string) => new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date());

export function TimezonePicker({ value, className, children }: { value: string; className?: string; children?: ReactNode }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Offsets and clocks for ~420 zones: worked out once per opening, not on every keystroke or hover.
  const info = useMemo(
    () => (open ? new Map([...new Set([value, ...Intl.supportedValuesOf("timeZone")])].map((z) => [z, { offset: offset(z), time: timeIn(z) }])) : new Map<string, { offset: string; time: string }>()),
    [open, value],
  );
  const zones = useMemo(() => {
    const all = [...info.keys()];
    const q = query.trim().toLowerCase().replace(/\s+/g, " ");
    const hits = q ? all.filter((z) => pretty(z).toLowerCase().includes(q) || info.get(z)!.offset.toLowerCase().includes(q)) : all;
    // Without a search: the device's zone and the current one lead.
    return q ? hits : [...new Set([device, value, ...hits])];
  }, [info, query, value, device]);

  const save = useMutation({
    mutationFn: (tz: string) => api.saveTimezone(tz),
    onSuccess: (_, tz) => {
      // Times show in this zone everywhere (queue, calendar, inbox): refetch it all.
      void qc.invalidateQueries();
      const from = value;
      toast({ title: `Timezone: ${pretty(tz)}`, tone: "success", actions: [{ label: "Undo", onClick: () => save.mutate(from) }] });
    },
    onError: (e) => toastError("Couldn't change the timezone", e),
  });

  const pick = (tz: string) => {
    setOpen(false);
    setQuery("");
    if (tz !== value) save.mutate(tz);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => (setOpen(o), setQuery(""), setActive(0))}
      align="start"
      className="w-80 p-0"
      trigger={
        <button aria-label={`Timezone: ${pretty(value)}`} className={className}>
          {children ?? pretty(value)}
        </button>
      }
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => (setQuery(e.target.value), setActive(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, zones.length - 1)));
          if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
          if (e.key === "Enter" && zones[active]) (e.preventDefault(), pick(zones[active]!));
        }}
        placeholder="City or GMT+7"
        aria-label="Search timezones"
        role="combobox"
        aria-expanded
        aria-controls="tz-list"
        aria-activedescendant={zones[active] ? `tz-${active}` : undefined}
        className="h-11 w-full rounded-t-xl border-b border-line bg-transparent px-3 text-sm outline-none placeholder:text-ink-3"
      />
      <ul id="tz-list" role="listbox" aria-label="Timezones" className="max-h-72 overflow-y-auto p-1">
        {zones.map((z, i) => (
          <li
            key={z}
            id={`tz-${i}`}
            role="option"
            aria-selected={z === value}
            ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
            onClick={() => pick(z)}
            onMouseMove={() => setActive(i)}
            className={cx("flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm", i === active && "bg-subtle")}
          >
            <span className="grid w-4 shrink-0 place-items-center text-ink-3">
              {z === value ? <Check size={14} className="text-ink" /> : z === device ? <Laptop size={13} aria-label="This device" /> : null}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {city(z)}
              {region(z) && <span className="text-ink-3"> · {region(z)}</span>}
            </span>
            <span className="shrink-0 text-xs text-ink-3 tabular-nums">
              {info.get(z)?.time} · {info.get(z)?.offset}
            </span>
          </li>
        ))}
        {!zones.length && <li className="px-2 py-6 text-center text-sm text-ink-3">No match</li>}
      </ul>
    </Popover>
  );
}
