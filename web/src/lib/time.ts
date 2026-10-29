// Date helpers that render in the server's configured timezone (not the browser's).

function parts(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
}

/** YYYY-MM-DD of an instant in `tz`. */
export function dayKey(date: Date | string, tz: string): string {
  const p = parts(new Date(date), tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function formatTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** "Wed, Oct 28" for a YYYY-MM-DD key. */
export function formatDate(key: string, withYear = false): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
  }).format(new Date(`${key}T12:00:00Z`));
}

/** "Today" / "Tomorrow" / "Yesterday" / null for a YYYY-MM-DD key. */
export function relativeDay(key: string, tz: string): string | null {
  const today = dayKey(new Date(), tz);
  if (key === today) return "Today";
  if (key === addDays(today, 1)) return "Tomorrow";
  if (key === addDays(today, -1)) return "Yesterday";
  return null;
}

/** "Today 9:00 AM", "Tomorrow 10:00 AM", "Fri, Oct 30 · 9:00 AM". */
export function formatWhen(iso: string, tz: string): string {
  const key = dayKey(iso, tz);
  const rel = relativeDay(key, tz);
  const year = key.slice(0, 4) !== dayKey(new Date(), tz).slice(0, 4);
  return rel ? `${rel} ${formatTime(iso, tz)}` : `${formatDate(key, year)} · ${formatTime(iso, tz)}`;
}

/** Value for <input type="datetime-local"> showing `iso` as wall time in `tz`. */
export function toZonedInput(iso: string, tz: string): string {
  const p = parts(new Date(iso), tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function offsetMs(utcMs: number, tz: string): number {
  const p = parts(new Date(utcMs), tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Inverse of toZonedInput: wall time in `tz` → ISO UTC. */
export function fromZonedInput(value: string, tz: string): string {
  const [date, time] = value.split("T");
  const [y, m, d] = date!.split("-").map(Number);
  const [h, min] = time!.split(":").map(Number);
  const wall = Date.UTC(y!, m! - 1, d!, h!, min!);
  const first = wall - offsetMs(wall, tz);
  return new Date(wall - offsetMs(first, tz)).toISOString();
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));
}
