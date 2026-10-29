// Weekly schedule controls shared by the posting slots and the operator: pick days, list times of day.
import { Plus, X } from "lucide-react";
import { useState } from "react";

/** Monday first, as JS day numbers (0 = Sunday). */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

const dayName = (d: number, style: "narrow" | "short" | "long") =>
  new Intl.DateTimeFormat(undefined, { weekday: style, timeZone: "UTC" }).format(Date.UTC(2023, 0, 1 + d)); // Jan 1 2023 was a Sunday

/** "17:30" in the reader's clock style. */
export const clock = (hhmm: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(Date.UTC(2000, 0, 1, +hhmm.slice(0, 2), +hhmm.slice(3)));

export function DayPicker({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
  return (
    <div className="flex gap-1" role="group" aria-label="Days">
      {WEEK.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort())}
          aria-pressed={days.includes(d)}
          aria-label={dayName(d, "long")}
          title={dayName(d, "long")}
          className="grid size-9 place-items-center rounded-full border border-line text-xs font-medium text-ink-2 transition-colors hover:border-line-strong aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-canvas"
        >
          {dayName(d, "narrow")}
        </button>
      ))}
    </div>
  );
}

/** Times of day as removable chips, plus a time input that adds one. */
export function TimeChips({ times, onChange, fallback = "09:00" }: { times: string[]; onChange: (times: string[]) => void; fallback?: string }) {
  const [time, setTime] = useState(fallback);
  const add = () => time && !times.includes(time) && onChange([...times, time].sort());
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Times">
      {times.map((t) => (
        <span key={t} className="flex h-8 items-center gap-1 rounded-full border border-line bg-canvas pr-1 pl-3 text-sm tabular-nums">
          {clock(t)}
          <button
            type="button"
            onClick={() => onChange(times.filter((x) => x !== t))}
            aria-label={`Remove ${clock(t)}`}
            className="grid size-6 place-items-center rounded-full text-ink-3 hover:bg-subtle hover:text-ink"
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <span className="flex h-8 items-center rounded-full border border-dashed border-line-strong pr-1 pl-2">
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
          aria-label="Time to add"
          className="bg-transparent text-sm tabular-nums outline-none"
        />
        <button type="button" onClick={add} aria-label="Add time" className="grid size-6 place-items-center rounded-full text-ink-3 hover:bg-subtle hover:text-ink">
          <Plus size={13} />
        </button>
      </span>
    </div>
  );
}
